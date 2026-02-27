/**
 * @strand/core — Phase 3 RED Tests: WASM Write Interface
 *
 * Problem: every StrandWriter.writeRecordBatch() call crosses the JS
 * serialization layer. A WASM BAM parser that computes pos, mapq, flag, tlen
 * must hand values back to JS, which then DataView-writes them one by one.
 * For millions of alignment records per second, this round-trip is measurable.
 *
 * Goal: expose a two-step claim/commit protocol so any code that holds a
 * reference to the SAB (WASM linear memory, SharedArrayBuffer view, etc.)
 * can write directly into ring slots — no JS serialization intermediary.
 *
 * ── New API surface on StrandWriter ────────────────────────────────────────
 *
 *   claimSlot(): { slotOffset: number; seq: number }
 *     Blocks for backpressure (same as writeRecordBatch).
 *     Returns the ABSOLUTE byte offset within the SAB of the claimed ring slot
 *     and the monotonic sequence number. Zero-fills the null bitmap bytes.
 *     The caller writes directly to sab[slotOffset + field.byteOffset].
 *
 *   commitSlot(seq: number): void
 *     Commits a single slot. Asserts seq === current COMMIT_SEQ (ordering
 *     guard). Advances HEAP_COMMIT, COMMIT_SEQ, and notifies.
 *
 *   claimSlots(count: number): ReadonlyArray<{ slotOffset: number; seq: number }>
 *     Claims `count` slots in one Atomics.add. Returns an array of
 *     { slotOffset, seq } for each — ready for WASM batch writes.
 *
 *   commitSlots(fromSeq: number, count: number): void
 *     Atomically commits `count` previously claimed slots starting at
 *     fromSeq. Asserts fromSeq === COMMIT_SEQ (ordering guard).
 *
 *   claimHeapBytes(byteLen: number): { physOffset: number; monoOffset: number }
 *     Exposes the heap ring allocator for variable-length field writes.
 *     physOffset: absolute byte in SAB to write string data.
 *     monoOffset: monotonic value to store in the index record's heap_offset u32.
 *     The wire format is always [monoOffset: u32][byteLen: u16] at field.byteOffset.
 *
 *   commitHeap(): void
 *     Advances CTRL_HEAP_COMMIT to the current CTRL_HEAP_WRITE. Call this
 *     before commitSlot/commitSlots when heap bytes were written.
 *
 * All tests are INTENTIONALLY RED until the methods are added to StrandWriter.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSchema,
  computeStrandMap,
  initStrandHeader,
  StrandView,
  StrandWriter,
  HEADER_SIZE,
} from '../src/index';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWriteBuf(
  fields: Parameters<typeof buildSchema>[0],
  opts: { capacity?: number; heapCapacity?: number } = {},
) {
  const capacity = opts.capacity ?? 32;
  const schema   = buildSchema(fields);
  const map      = computeStrandMap({
    schema,
    index_capacity:    capacity,
    heap_capacity:     opts.heapCapacity ?? 0,
    query:             { assembly: 'test', chrom: 'chr1', start: 0, end: 1_000_000 },
    estimated_records: capacity,
  });
  const sab    = new SharedArrayBuffer(map.total_bytes);
  initStrandHeader(sab, map);
  const view   = new StrandView(sab);
  const writer = new StrandWriter(sab);
  writer.begin();
  return { sab, view, writer, schema, map };
}

// ─── Group 1: claimSlot + commitSlot ─────────────────────────────────────────

describe('Phase 3 — claimSlot + commitSlot', () => {

  it('claimSlot() returns an object with {slotOffset: number, seq: number}', () => {
    //
    // Currently FAILS: StrandWriter has no claimSlot() method.
    // TypeError: writer.claimSlot is not a function
    //
    const { writer } = makeWriteBuf([{ name: 'id', type: 'u32' }]);

    // @ts-expect-error — method not yet implemented
    const claim = writer.claimSlot();

    expect(typeof claim).toBe('object');
    expect(typeof claim.slotOffset).toBe('number');
    expect(typeof claim.seq).toBe('number');
    expect(claim.seq).toBe(0); // first claim on a fresh buffer
  });

  it('slotOffset matches the ring formula: HEADER_SIZE + (seq % capacity) * stride', () => {
    //
    // The physical slot address must equal exactly what the reader computes
    // from the same seq and the stored geometry. If the formula is wrong,
    // the reader and writer will be looking at different bytes.
    //
    const { writer, map } = makeWriteBuf([{ name: 'id', type: 'u32' }]);

    for (let i = 0; i < 3; i++) {
      // @ts-expect-error
      const { slotOffset, seq } = writer.claimSlot();
      // @ts-expect-error
      writer.commitSlot(seq);

      const expectedOffset =
        HEADER_SIZE + (seq & (map.index_capacity - 1)) * map.record_stride;
      expect(slotOffset).toBe(expectedOffset);
    }
  });

  it('writing into slotOffset + field.byteOffset and calling commitSlot() makes the record readable', () => {
    //
    // Core WASM pattern: claim → write via DataView (simulating WASM i32.store)
    // → commit → cursor reads back the written value.
    //
    const { sab, view, writer, schema } = makeWriteBuf([
      { name: 'id',    type: 'u32' },
      { name: 'score', type: 'f64' },
    ]);

    // @ts-expect-error
    const { slotOffset, seq } = writer.claimSlot();

    const idField    = schema.fields.find(f => f.name === 'id')!;
    const scoreField = schema.fields.find(f => f.name === 'score')!;

    // Simulate WASM direct memory writes (i32.store / f64.store).
    new DataView(sab).setUint32(slotOffset + idField.byteOffset,    99,    true);
    new DataView(sab).setFloat64(slotOffset + scoreField.byteOffset, 2.718, true);

    // @ts-expect-error
    writer.commitSlot(seq);

    const cursor = view.allocateCursor();
    cursor.seek(0);
    expect(cursor.getU32('id')).toBe(99);
    expect(cursor.getF64('score')).toBeCloseTo(2.718);
  });

  it('seq increments by one for each claimSlot call', () => {
    const { writer } = makeWriteBuf([{ name: 'id', type: 'u32' }]);

    for (let expected = 0; expected < 5; expected++) {
      // @ts-expect-error
      const { seq } = writer.claimSlot();
      expect(seq).toBe(expected);
      // @ts-expect-error
      writer.commitSlot(seq);
    }
  });

  it('commitSlot(wrongSeq) throws RangeError — enforces ordering', () => {
    //
    // Committing a seq that is not the next expected COMMIT_SEQ would create
    // a gap in the committed range, which would make the consumer skip records.
    // This is explicitly disallowed.
    //
    const { writer } = makeWriteBuf([{ name: 'id', type: 'u32' }]);

    // @ts-expect-error
    writer.claimSlot(); // claims seq 0, but we do NOT commit it correctly

    // Trying to commit seq 5 (out of order) must throw.
    // @ts-expect-error
    expect(() => writer.commitSlot(5)).toThrow(RangeError);
  });

});

// ─── Group 2: claimSlots + commitSlots (batch) ───────────────────────────────

describe('Phase 3 — claimSlots + commitSlots', () => {

  it('claimSlots(count) returns an array of length count with sequential seqs', () => {
    //
    // Currently FAILS: StrandWriter has no claimSlots() method.
    //
    const { writer } = makeWriteBuf([{ name: 'id', type: 'u32' }]);

    // @ts-expect-error
    const claims = writer.claimSlots(4);

    expect(Array.isArray(claims)).toBe(true);
    expect(claims).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(claims[i].seq).toBe(i);
    }
  });

  it('filling all claimed slots + commitSlots makes all records visible', () => {
    //
    // WASM batch-write pattern:
    //   1. claimSlots(N) — claim N slots in one atomic operation
    //   2. WASM fills each slot (simulated by DataView writes here)
    //   3. commitSlots(fromSeq, N) — commit the whole batch atomically
    //
    const { sab, view, writer, schema } = makeWriteBuf([{ name: 'id', type: 'u32' }]);
    const idField = schema.fields.find(f => f.name === 'id')!;
    const N = 8;

    // @ts-expect-error
    const claims: Array<{ slotOffset: number; seq: number }> = writer.claimSlots(N);

    // Simulate WASM writing each record.
    for (const { slotOffset, seq } of claims) {
      new DataView(sab).setUint32(slotOffset + idField.byteOffset, seq * 10, true);
    }

    // @ts-expect-error
    writer.commitSlots(claims[0].seq, N);

    const cursor = view.allocateCursor();
    for (let i = 0; i < N; i++) {
      cursor.seek(i);
      expect(cursor.getU32('id')).toBe(i * 10);
    }
  });

  it('commitSlots(wrongFromSeq, count) throws RangeError', () => {
    const { writer } = makeWriteBuf([{ name: 'id', type: 'u32' }]);

    // @ts-expect-error
    writer.claimSlots(4); // seqs 0..3

    // Trying to commit from seq 2 (skipping 0 and 1) must throw.
    // @ts-expect-error
    expect(() => writer.commitSlots(2, 2)).toThrow(RangeError);
  });

});

// ─── Group 3: claimHeapBytes + commitHeap (variable-length writes) ───────────

describe('Phase 3 — claimHeapBytes + commitHeap', () => {

  it('claimHeapBytes(n) returns {physOffset: number, monoOffset: number}', () => {
    //
    // Currently FAILS: StrandWriter has no claimHeapBytes() method.
    //
    const { writer } = makeWriteBuf(
      [{ name: 'id', type: 'u32' }, { name: 'name', type: 'utf8' }],
      { heapCapacity: 1024 },
    );

    // @ts-expect-error
    const result = writer.claimHeapBytes(10);

    expect(typeof result.physOffset).toBe('number');
    expect(typeof result.monoOffset).toBe('number');
    // physOffset is within the heap region of the SAB
    expect(result.physOffset).toBeGreaterThanOrEqual(0);
  });

  it('writing a utf8 string via claimHeapBytes + claimSlot + commitHeap + commitSlot makes getString() work', () => {
    //
    // Full WASM variable-length write protocol:
    //
    //   1. Claim a ring slot.
    //   2. Claim heap bytes for the string.
    //   3. Write string bytes at physOffset (WASM memcpy).
    //   4. Write [monoOffset: u32][byteLen: u16] into the index slot at field.byteOffset.
    //   5. commitHeap() — advance HEAP_COMMIT.
    //   6. commitSlot(seq) — advance COMMIT_SEQ.
    //
    const { sab, view, writer, schema, map } = makeWriteBuf(
      [{ name: 'tag', type: 'utf8' }],
      { heapCapacity: 1024 },
    );

    const tagField    = schema.fields.find(f => f.name === 'tag')!;
    const heapStart   = map.total_bytes - map.heap_capacity; // byte offset of heap in SAB

    const text    = 'hello_wasm';
    const encoded = new TextEncoder().encode(text);

    // @ts-expect-error
    const { slotOffset, seq }       = writer.claimSlot();
    // @ts-expect-error
    const { physOffset, monoOffset } = writer.claimHeapBytes(encoded.length);

    // Write the string bytes directly into the SAB heap region.
    new Uint8Array(sab, heapStart + physOffset, encoded.length).set(encoded);

    // Write the heap pointer fields into the index slot.
    new DataView(sab).setUint32(slotOffset + tagField.byteOffset,     monoOffset,      true);
    new DataView(sab).setUint16(slotOffset + tagField.byteOffset + 4, encoded.length,  true);

    // @ts-expect-error
    writer.commitHeap();
    // @ts-expect-error
    writer.commitSlot(seq);

    const cursor = view.allocateCursor();
    cursor.seek(0);
    expect(cursor.getString('tag')).toBe(text);
  });

});
