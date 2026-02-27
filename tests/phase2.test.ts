/**
 * @strand/core — Phase 2 RED Tests
 *
 * Two features documented here are NOT YET IMPLEMENTED. Every test in this
 * file is intentionally RED. It describes the contract; src/ must grow to
 * satisfy it.
 *
 * ── Feature A: Null Validity Bitmap ─────────────────────────────────────────
 *
 *   Fields declared with FIELD_FLAG_NULLABLE may be omitted from any record
 *   in a writeRecordBatch() call. When the consumer reads an omitted nullable
 *   field via cursor.getU32() / getI32() / etc., it MUST receive null — not
 *   the zero value that currently occupies the unwritten slot bytes.
 *
 *   Non-nullable fields that are omitted still return the zero value (current
 *   behaviour) — this is a programmer error, not a null signal.
 *
 *   Implementation hint (no src/ changes yet — this comment is the spec):
 *     buildSchema() reserves Math.ceil(nullableCount / 8) bytes at the very
 *     start of every record slot for a null bitmap. Bit k of byte 0 is 1 when
 *     nullable field k is present. The writer sets the bit when it writes a
 *     value; the cursor checks the bit before returning a value.
 *
 * ── Feature B: Multi-Consumer Backpressure ──────────────────────────────────
 *
 *   Currently a single CTRL_READ_CURSOR word gates the producer.
 *   The plan:
 *     - view.registerConsumer() → token: number
 *         Claims one of up to N consumer slots in the Atomics section.
 *         Throws RangeError if all slots are occupied.
 *
 *     - view.acknowledgeRead(upTo, token) → void
 *         Advances only the cursor for `token`. Signature is backwards-
 *         compatible: if no token is passed, it falls back to the legacy
 *         single-consumer CTRL_READ_CURSOR.
 *
 *     - view.releaseConsumer(token) → void
 *         Removes the consumer slot from backpressure accounting.
 *
 *     - view.effectiveReadCursor → number
 *         Returns Math.min(...all active consumer cursors).
 *         This is the value the producer uses for ring-space accounting.
 *
 *   Producer backpressure: waitForIndexSpace() replaces its
 *   Atomics.load(ctrl, CTRL_READ_CURSOR) with a scan of all live slots.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSchema,
  computeStrandMap,
  initStrandHeader,
  StrandView,
  StrandWriter,
  FIELD_FLAG_NULLABLE,
} from '../src/index';

// ─── Shared helper ────────────────────────────────────────────────────────────

function makeBuf(
  fields: Parameters<typeof buildSchema>[0],
  capacity = 32,
) {
  const schema = buildSchema(fields);
  const map    = computeStrandMap({
    schema,
    index_capacity:    capacity,
    heap_capacity:     0,
    query:             { assembly: 'test', chrom: 'chr1', start: 0, end: 1_000_000 },
    estimated_records: capacity,
  });
  const sab = new SharedArrayBuffer(map.total_bytes);
  initStrandHeader(sab, map);
  const view   = new StrandView(sab);
  const writer = new StrandWriter(sab);
  writer.begin();
  return { view, writer };
}

// ─── Feature A: Null Validity Bitmap ─────────────────────────────────────────

describe('Phase 2A — Null Validity Bitmap', () => {

  it('nullable field omitted during write returns null from cursor', () => {
    //
    // Schema: { pos: nullable u32, score: non-nullable u32 }
    // Write one record supplying only 'score'; omit 'pos'.
    //
    // Expected behaviour:
    //   cursor.getU32('pos')   → null  (nullable, not written)
    //   cursor.getU32('score') → 42    (explicitly written)
    //
    // Currently FAILS because:
    //   FIELD_FLAG_NULLABLE has no effect on the write path or read path.
    //   The zero-initialised slot bytes make getU32() return 0, not null.
    //
    const { view, writer } = makeBuf([
      { name: 'pos',   type: 'u32', flags: FIELD_FLAG_NULLABLE },
      { name: 'score', type: 'u32' },
    ]);

    writer.writeRecordBatch([{ score: 42 }]); // 'pos' deliberately omitted

    const cursor = view.allocateCursor();
    cursor.seek(0);

    expect(cursor.getU32('pos')).toBeNull();  // RED: currently returns 0
    expect(cursor.getU32('score')).toBe(42);
  });

  it('nullable field with an explicit value returns that value', () => {
    //
    // Sanity-check: when the writer DOES supply a value for a nullable field,
    // the cursor must still return it correctly. The null-bitmap bit is 1
    // (present), so the cursor reads through to the actual bytes.
    //
    // Currently FAILS when the null-bitmap shifts field byte offsets —
    // once buildSchema() reserves bitmap bytes at the front of the record,
    // the stored byteOffset for 'pos' changes and the cursor must use the
    // updated offset.
    //
    const { view, writer } = makeBuf([
      { name: 'pos',   type: 'u32', flags: FIELD_FLAG_NULLABLE },
      { name: 'score', type: 'u32' },
    ]);

    writer.writeRecordBatch([{ pos: 100, score: 42 }]);

    const cursor = view.allocateCursor();
    cursor.seek(0);

    expect(cursor.getU32('pos')).toBe(100);
    expect(cursor.getU32('score')).toBe(42);
  });

  it('non-nullable field omitted during write returns zero (not null)', () => {
    //
    // Non-nullable fields do not participate in the null bitmap.
    // Omitting them is a developer error, not a null signal.
    // The zero-valued bytes must be returned unchanged.
    //
    // This test documents the NON-null path so the implementation cannot
    // accidentally mark all omitted fields as null regardless of the flag.
    //
    const { view, writer } = makeBuf([
      { name: 'pos',   type: 'u32', flags: FIELD_FLAG_NULLABLE },
      { name: 'score', type: 'u32' },
    ]);

    writer.writeRecordBatch([{ pos: 7 }]); // 'score' omitted, non-nullable

    const cursor = view.allocateCursor();
    cursor.seek(0);

    expect(cursor.getU32('pos')).toBe(7);
    expect(cursor.getU32('score')).toBe(0); // non-nullable omitted → 0, not null
  });

  it('multiple nullable fields each get their own bitmap bit', () => {
    //
    // Three nullable fields: a, b, c. Write records where each combination
    // of present/absent fields is represented.
    //
    // record 0: only 'a'  → a=1, b=null, c=null
    // record 1: only 'b'  → a=null, b=2,  c=null
    // record 2: all three → a=3,    b=4,   c=5
    //
    const { view, writer } = makeBuf([
      { name: 'a', type: 'u32', flags: FIELD_FLAG_NULLABLE },
      { name: 'b', type: 'u32', flags: FIELD_FLAG_NULLABLE },
      { name: 'c', type: 'u32', flags: FIELD_FLAG_NULLABLE },
    ]);

    writer.writeRecordBatch([
      { a: 1 },
      { b: 2 },
      { a: 3, b: 4, c: 5 },
    ]);

    const cursor = view.allocateCursor();

    cursor.seek(0);
    expect(cursor.getU32('a')).toBe(1);
    expect(cursor.getU32('b')).toBeNull(); // RED: returns 0 today
    expect(cursor.getU32('c')).toBeNull(); // RED: returns 0 today

    cursor.seek(1);
    expect(cursor.getU32('a')).toBeNull(); // RED: returns 0 today
    expect(cursor.getU32('b')).toBe(2);
    expect(cursor.getU32('c')).toBeNull(); // RED: returns 0 today

    cursor.seek(2);
    expect(cursor.getU32('a')).toBe(3);
    expect(cursor.getU32('b')).toBe(4);
    expect(cursor.getU32('c')).toBe(5);
  });

});

// ─── Feature B: Multi-Consumer Backpressure ──────────────────────────────────

describe('Phase 2B — Multi-Consumer Backpressure', () => {

  it('registerConsumer() returns a unique integer token for each caller', () => {
    //
    // Currently FAILS: StrandView has no registerConsumer() method.
    // TypeError: view.registerConsumer is not a function
    //
    const { view } = makeBuf([{ name: 'id', type: 'u32' }], 32);

    // @ts-expect-error — method does not exist yet
    const tokenA: number = view.registerConsumer();
    // @ts-expect-error
    const tokenB: number = view.registerConsumer();

    expect(typeof tokenA).toBe('number');
    expect(typeof tokenB).toBe('number');
    expect(tokenA).not.toBe(tokenB);
  });

  it('effectiveReadCursor reflects the minimum ack position across all consumers', () => {
    //
    // Two consumers share a ring of capacity 32.
    // Consumer A acks 16 records; consumer B acks only 8 records.
    // The effective gate for the producer must be min(16, 8) = 8.
    //
    // Currently FAILS:
    //   1. registerConsumer() does not exist.
    //   2. acknowledgeRead() ignores the token argument (single-consumer model).
    //   3. effectiveReadCursor property does not exist.
    //
    const { view, writer } = makeBuf([{ name: 'id', type: 'u32' }], 32);

    // @ts-expect-error
    const tokenA: number = view.registerConsumer();
    // @ts-expect-error
    const tokenB: number = view.registerConsumer();

    writer.writeRecordBatch(Array.from({ length: 16 }, (_, i) => ({ id: i })));

    // Consumer A has fully processed the batch; B is only halfway.
    // @ts-expect-error
    view.acknowledgeRead(16, tokenA);
    // @ts-expect-error
    view.acknowledgeRead(8,  tokenB);

    // The producer may only reclaim slots up to the minimum ack position.
    // @ts-expect-error
    expect(view.effectiveReadCursor).toBe(8);
  });

  it('releaseConsumer() removes the token and advances the effective cursor', () => {
    //
    // After consumer B releases its slot, only consumer A remains.
    // The effective cursor advances from 8 to 16.
    //
    // Currently FAILS: releaseConsumer() does not exist.
    //
    const { view, writer } = makeBuf([{ name: 'id', type: 'u32' }], 32);

    // @ts-expect-error
    const tokenA: number = view.registerConsumer();
    // @ts-expect-error
    const tokenB: number = view.registerConsumer();

    writer.writeRecordBatch(Array.from({ length: 16 }, (_, i) => ({ id: i })));

    // @ts-expect-error
    view.acknowledgeRead(16, tokenA);
    // @ts-expect-error
    view.acknowledgeRead(8,  tokenB);

    // Before release: gate is at 8 (B is the bottleneck).
    // @ts-expect-error
    expect(view.effectiveReadCursor).toBe(8);

    // Consumer B finishes and releases its slot.
    // @ts-expect-error
    view.releaseConsumer(tokenB);

    // After release: only A remains; effective cursor advances to A's position.
    // @ts-expect-error
    expect(view.effectiveReadCursor).toBe(16);
  });

});
