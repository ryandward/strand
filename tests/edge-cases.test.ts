/**
 * @strand/core — Structural Audit: Edge-Case Exploits
 *
 * Four tests that exercise inputs the engine currently accepts silently
 * but should reject loudly. Each test is intentionally RED — it documents
 * a known gap in validation that must be fixed in src/ before it can pass.
 *
 * Items under test:
 *   6  — Stride Overflow: a crafted schema where byteOffset + field_width
 *         exceeds record_stride. readStrandHeader() must detect this.
 *
 *   7  — Negative Range: computeStrandMap() called with query.start > query.end.
 *         Must throw RangeError before any buffer is allocated.
 *
 *  10  — Divide by Zero: computeStrandMap() called with heap_capacity=0 on a
 *         schema containing utf8/json fields. claimHeap() would silently produce
 *         NaN for every physOffset via `n % 0`. Must be caught at map-build time.
 *
 *  13  — Status Race: calling abort() followed by finalize() must leave
 *         STATUS_ERROR intact. Currently finalize() uses Atomics.store and
 *         unconditionally overwrites ERROR with EOS.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSchema,
  computeStrandMap,
  initStrandHeader,
  readStrandHeader,
  StrandHeaderError,
  StrandView,
  StrandWriter,
  HEADER_SIZE,
  schemaFingerprint,
} from '../src/index';
import type { BinarySchemaDescriptor, StrandMap } from '../src/index';

// ─── Shared helpers ────────────────────────────────────────────────────────────

/** Build a minimal valid SAB + view + writer for status-race tests. */
function makeMinimalBuf() {
  const schema = buildSchema([{ name: 'id', type: 'u32' }]);
  const map    = computeStrandMap({
    schema,
    index_capacity:    16,
    heap_capacity:     0,
    query:             { assembly: 'test', chrom: 'chr1', start: 0, end: 1000 },
    estimated_records: 10,
  });
  const sab = new SharedArrayBuffer(map.total_bytes);
  initStrandHeader(sab, map);
  return {
    view:   new StrandView(sab),
    writer: new StrandWriter(sab),
  };
}

// ─── Item 6: Stride Overflow ───────────────────────────────────────────────────

describe('Item 6 — Stride Overflow', () => {
  it('readStrandHeader() rejects a schema where a field\'s byteOffset + width exceeds record_stride', () => {
    //
    // Manually construct a BinarySchemaDescriptor that buildSchema() would
    // never produce: a single u32 field placed at byteOffset=8, while
    // record_stride is declared as 4. The field's last byte sits at offset 11,
    // which is 7 bytes past the end of the slot.
    //
    // If a writer uses record_stride=4 for ring slot arithmetic and a reader
    // accesses byteOffset=8 within that slot, the reader silently aliases into
    // the next slot — a class of memory-safety bug that must be caught at
    // header validation time.
    //
    // This schema passes initStrandHeader() today (it only checks
    // `record_stride % 4 === 0` and fingerprint consistency, not field layout).
    // readStrandHeader() must detect the inconsistency: the decoded schema's
    // field layout implies record_stride >= 12, but the header's geometry
    // section says 4.
    //
    const badSchema: BinarySchemaDescriptor = {
      fields:        [{ name: 'x', type: 'u32', byteOffset: 8, flags: 0 }],
      record_stride: 4, // 8 + 4 = 12 > 4: field overflows the slot boundary
    };

    // Build a StrandMap that faithfully reflects badSchema. computeStrandMap()
    // takes schema.record_stride at face value — no stride coherence check.
    const map = computeStrandMap({
      schema:            badSchema,
      index_capacity:    16,
      heap_capacity:     0,
      query:             { assembly: '', chrom: '', start: 0, end: 0 },
      estimated_records: 0,
    });
    // total_bytes = HEADER_SIZE + 16 * 4 + 0 = 576

    const sab = new SharedArrayBuffer(map.total_bytes);

    // initStrandHeader() writes record_stride=4 into the geometry section
    // and encodes the schema with byteOffset=8. It does not validate that
    // every field fits within record_stride, so it currently succeeds.
    initStrandHeader(sab, map);

    // readStrandHeader() must decode the schema, recompute the stride from
    // field layout (= 12), compare it to the geometry value (= 4), and throw.
    expect(() => readStrandHeader(sab)).toThrow(StrandHeaderError);
  });
});

// ─── Item 7: Negative Range ───────────────────────────────────────────────────

describe('Item 7 — Negative Range', () => {
  it('computeStrandMap() throws RangeError when query.start > query.end', () => {
    //
    // A query range where start > end is logically incoherent: it represents
    // a negative-length genomic interval. Passing it through produces a
    // StrandMap with an internally contradictory query field that will silently
    // mislead any downstream code that trusts map.query.
    //
    // computeStrandMap() is the correct place to enforce this: it builds the
    // StrandMap, so it should validate the query before returning one.
    //
    const schema = buildSchema([{ name: 'id', type: 'u32' }]);

    expect(() =>
      computeStrandMap({
        schema,
        index_capacity:    16,
        heap_capacity:     0,
        query:             { assembly: 'hg38', chrom: 'chr1', start: 100, end: 50 },
        estimated_records: 0,
      }),
    ).toThrow(RangeError);
  });
});

// ─── Item 10: Divide by Zero ──────────────────────────────────────────────────

describe('Item 10 — Divide by Zero', () => {
  it('computeStrandMap() throws when heap_capacity=0 but schema contains utf8/json fields', () => {
    //
    // When heap_capacity=0, the writer's claimHeap() computes:
    //
    //   const physCursor = heapWrite % this.map.heap_capacity;
    //                                ^                   ^ = 0
    //
    // In JavaScript `n % 0 === NaN`. That NaN propagates silently into
    // DataView.setUint32 / setUint16 (which coerce it to 0), so every heap
    // pointer in every record points to physOffset=0. All variable-length
    // fields alias the same byte — reads return garbage without any error.
    //
    // The failure should be caught at map-build time, not at runtime inside
    // claimHeap(), so the caller can fix the configuration before any buffer
    // is allocated or any byte is written.
    //
    const schema = buildSchema([
      { name: 'id',    type: 'u32'  },
      { name: 'label', type: 'utf8' }, // requires heap
    ]);

    expect(() =>
      computeStrandMap({
        schema,
        index_capacity:    16,
        heap_capacity:     0,           // ← the bad value
        query:             { assembly: '', chrom: '', start: 0, end: 1000 },
        estimated_records: 100,
      }),
    ).toThrow();
  });

  it('computeStrandMap() also throws when schema contains json fields with heap_capacity=0', () => {
    const schema = buildSchema([
      { name: 'id',   type: 'u32'  },
      { name: 'meta', type: 'json' }, // also requires heap
    ]);

    expect(() =>
      computeStrandMap({
        schema,
        index_capacity:    16,
        heap_capacity:     0,
        query:             { assembly: '', chrom: '', start: 0, end: 1000 },
        estimated_records: 100,
      }),
    ).toThrow();
  });

  it('computeStrandMap() allows heap_capacity=0 when schema has no variable-length fields', () => {
    // Sanity-check the happy path: a fixed-width-only schema with heap=0 is valid.
    const schema = buildSchema([
      { name: 'id',  type: 'u32' },
      { name: 'pos', type: 'i64' },
    ]);

    expect(() =>
      computeStrandMap({
        schema,
        index_capacity:    16,
        heap_capacity:     0,           // fine — nothing will ever call claimHeap
        query:             { assembly: '', chrom: '', start: 0, end: 1000 },
        estimated_records: 100,
      }),
    ).not.toThrow();
  });
});

// ─── Item 13: Status Race ─────────────────────────────────────────────────────

describe('Item 13 — Status Race', () => {
  it('finalize() after abort() must not overwrite STATUS_ERROR with STATUS_EOS', () => {
    //
    // The exploit:
    //
    //   1. writer.abort()    → Atomics.store(STATUS_ERROR)
    //   2. writer.finalize() → Atomics.store(STATUS_EOS)   ← silently overwrites ERROR
    //   3. view.status       === 'eos'                     ← wrong; should be 'error'
    //
    // STATUS_ERROR is a terminal state that signals to the consumer that the
    // stream failed. A subsequent finalize() — whether from a race, a bug, or
    // an ill-ordered lifecycle call — must not overwrite that signal with the
    // "clean" EOS status. The consumer would then believe the stream completed
    // successfully and might attempt to use partial / corrupt data.
    //
    // Fix: replace Atomics.store in finalize() with Atomics.compareExchange
    // so it only transitions STREAMING → EOS, leaving any other status intact.
    //
    const { view, writer } = makeMinimalBuf();

    writer.begin();    // STATUS: INITIALIZING → STREAMING
    writer.abort();    // STATUS: STREAMING    → ERROR  (terminal)
    writer.finalize(); // must be a no-op — ERROR is terminal

    // Currently FAILS: finalize() stores STATUS_EOS unconditionally, and
    // view.status returns 'eos'. The assertion below catches this.
    expect(view.status).toBe('error');
  });

  it('abort() after finalize() must set STATUS_ERROR (error supersedes EOS)', () => {
    //
    // The converse race: the consumer signals an abort after the producer has
    // already finalized. The consumer may not yet have observed the EOS status
    // (e.g., it woke late). An abort signal must still land and be detectable
    // so the consumer knows to discard any buffered records from a corrupted
    // tail.
    //
    // With both finalize() and abort() using plain Atomics.store this test
    // already passes — it is included as a regression guard to ensure that
    // fixing Item 13 (by adding CAS to finalize) does not accidentally break
    // the abort-supersedes-EOS direction.
    //
    const { view, writer } = makeMinimalBuf();

    writer.begin();
    writer.finalize(); // STATUS: STREAMING → EOS
    writer.abort();    // STATUS: EOS       → ERROR (abort must win)

    expect(view.status).toBe('error');
  });
});
