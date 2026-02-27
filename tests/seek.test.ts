/**
 * @strand/core — Sorted Seek Tests (Phase 1)
 *
 * Tests for StrandView.findFirst(field, value): binary search on a
 * FIELD_FLAG_SORTED_ASC field across the committed ring.
 *
 * All tests run single-threaded on the main Node.js thread (Atomics.wait
 * is legal here). index_capacity is always set >= record count so the
 * writer never stalls on backpressure.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildSchema,
  computeStrandMap,
  initStrandHeader,
  StrandView,
  StrandWriter,
  FIELD_FLAG_SORTED_ASC,
} from '../src/index';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeSeekBuf(opts: {
  capacity:     number;
  fields?:      Parameters<typeof buildSchema>[0];
  heapCapacity?: number;
}) {
  const fields = opts.fields ?? [
    { name: 'pos', type: 'u32' as const, flags: FIELD_FLAG_SORTED_ASC },
  ];
  const schema = buildSchema(fields);
  const map    = computeStrandMap({
    schema,
    index_capacity:    opts.capacity,
    heap_capacity:     opts.heapCapacity ?? 0,
    query:             { assembly: 'test', chrom: 'chr1', start: 0, end: 1_000_000 },
    estimated_records: opts.capacity,
  });
  const sab = new SharedArrayBuffer(map.total_bytes);
  initStrandHeader(sab, map);
  const view   = new StrandView(sab);
  const writer = new StrandWriter(sab);
  writer.begin();
  return { view, writer };
}

/** Write `count` records with pos = [start, start+step, start+2*step, ...]. */
function writeLinear(
  writer: StrandWriter,
  count:  number,
  start:  number = 0,
  step:   number = 1,
) {
  writer.writeRecordBatch(
    Array.from({ length: count }, (_, i) => ({ pos: start + i * step })),
  );
}

// ─── basic lower-bound behaviour ─────────────────────────────────────────────

describe('findFirst — basic lower-bound', () => {
  it('returns the seq of the exact match when value exists', () => {
    // pos: [0, 1, 2, ..., 99]  →  findFirst(50) === 50
    const { view, writer } = makeSeekBuf({ capacity: 128 });
    writeLinear(writer, 100);

    expect(view.findFirst('pos', 50)).toBe(50);
  });

  it('returns the first seq when target is below all values', () => {
    // pos: [10, 11, ..., 19]  →  findFirst(5) === 0  (pos=10 is the first >= 5)
    const { view, writer } = makeSeekBuf({ capacity: 32 });
    writeLinear(writer, 10, /* start */ 10);

    expect(view.findFirst('pos', 5)).toBe(0);
  });

  it('returns -1 when target is strictly above all committed values', () => {
    // pos: [0..99]  →  findFirst(100) === -1
    const { view, writer } = makeSeekBuf({ capacity: 128 });
    writeLinear(writer, 100);

    expect(view.findFirst('pos', 100)).toBe(-1);
  });

  it('returns -1 on an empty ring (nothing committed yet)', () => {
    const { view } = makeSeekBuf({ capacity: 16 });
    // writer.begin() called but no writeRecordBatch
    expect(view.findFirst('pos', 0)).toBe(-1);
  });

  it('returns the correct seq for a non-contiguous sorted series', () => {
    // pos: [0, 2, 4, 6, 8]  →  findFirst(3) → seq 2  (pos=4 is first >= 3)
    const { view, writer } = makeSeekBuf({ capacity: 16 });
    writer.writeRecordBatch([
      { pos: 0 }, { pos: 2 }, { pos: 4 }, { pos: 6 }, { pos: 8 },
    ]);

    const seq = view.findFirst('pos', 3);
    expect(seq).toBe(2); // seq 2 has pos=4, which is the first value >= 3
  });

  it('returns the first seq when multiple records share the target value', () => {
    // pos: [1, 1, 1, 5, 5, 5]  →  findFirst(1) === 0
    const { view, writer } = makeSeekBuf({ capacity: 16 });
    writer.writeRecordBatch([
      { pos: 1 }, { pos: 1 }, { pos: 1 },
      { pos: 5 }, { pos: 5 }, { pos: 5 },
    ]);

    expect(view.findFirst('pos', 1)).toBe(0);
    expect(view.findFirst('pos', 5)).toBe(3);
  });

  it('returns 0 when all records have the same value and it matches', () => {
    const { view, writer } = makeSeekBuf({ capacity: 16 });
    writer.writeRecordBatch(Array.from({ length: 8 }, () => ({ pos: 42 })));

    expect(view.findFirst('pos', 42)).toBe(0);
  });

  it('returns -1 when all records are below the target', () => {
    const { view, writer } = makeSeekBuf({ capacity: 16 });
    writer.writeRecordBatch(Array.from({ length: 8 }, () => ({ pos: 42 })));

    expect(view.findFirst('pos', 43)).toBe(-1);
  });
});

// ─── ring-lap behaviour ───────────────────────────────────────────────────────

describe('findFirst — after ring has lapped', () => {
  it('returns oldest available seq when target value is below the oldest available value', () => {
    // capacity=16, write 32 records pos=[0..31].
    // After acknowledgeRead(16) + second batch, oldest=16, committed=32.
    //
    // findFirst searches for VALUES not seqs. The lower_bound of pos=5 in the
    // available window [pos=16..31] is seq=16 (pos=16 is the first value >= 5).
    // The function correctly returns 16 — it found data satisfying pos >= 5.
    //
    // The CALLER is responsible for detecting eviction by checking the returned
    // record's actual field value:
    //
    //   const seq = view.findFirst('pos', target);
    //   cursor.seek(seq);
    //   if (cursor.getU32('pos')! > target + acceptableGap) {
    //     restartStream(target); // ring lapped past the desired region
    //   }
    const { view, writer } = makeSeekBuf({ capacity: 16 });
    writeLinear(writer, 16);        // pos 0..15
    view.acknowledgeRead(16);       // release all 16 slots
    writeLinear(writer, 16, 16);    // pos 16..31

    // Target below oldest available value → lower_bound is the oldest seq.
    expect(view.findFirst('pos', 5)).toBe(16);   // pos=16 is first >= 5
    expect(view.findFirst('pos', 15)).toBe(16);  // pos=16 is first >= 15
    expect(view.findFirst('pos', 16)).toBe(16);  // exact match at oldest
  });

  it('returns the correct seq for a target inside the available window', () => {
    const { view, writer } = makeSeekBuf({ capacity: 16 });
    writeLinear(writer, 16);
    view.acknowledgeRead(16);
    writeLinear(writer, 16, 16);

    // committed=32, oldest=16
    expect(view.findFirst('pos', 16)).toBe(16);
    expect(view.findFirst('pos', 20)).toBe(20);
    expect(view.findFirst('pos', 31)).toBe(31);
  });

  it('returns -1 when target exceeds the newest committed value after a lap', () => {
    const { view, writer } = makeSeekBuf({ capacity: 16 });
    writeLinear(writer, 16);
    view.acknowledgeRead(16);
    writeLinear(writer, 16, 16);

    expect(view.findFirst('pos', 32)).toBe(-1);
  });
});

// ─── field type coverage ─────────────────────────────────────────────────────

describe('findFirst — field types', () => {
  it('works with i32 fields', () => {
    const { view, writer } = makeSeekBuf({
      capacity: 32,
      fields: [{ name: 'score', type: 'i32', flags: FIELD_FLAG_SORTED_ASC }],
    });
    writer.writeRecordBatch(
      Array.from({ length: 10 }, (_, i) => ({ score: i - 5 })), // -5..4
    );

    expect(view.findFirst('score', -5)).toBe(0);
    expect(view.findFirst('score', 0)).toBe(5);   // seq 5 has score=0
    expect(view.findFirst('score', 4)).toBe(9);
    expect(view.findFirst('score', 5)).toBe(-1);
  });

  it('works with i64 fields using bigint target', () => {
    const { view, writer } = makeSeekBuf({
      capacity: 32,
      fields: [{ name: 'pos', type: 'i64', flags: FIELD_FLAG_SORTED_ASC }],
    });
    writer.writeRecordBatch(
      Array.from({ length: 10 }, (_, i) => ({ pos: BigInt(i * 1000) })),
    );
    // pos: [0n, 1000n, 2000n, ..., 9000n]

    expect(view.findFirst('pos', 0n)).toBe(0);
    expect(view.findFirst('pos', 2500n)).toBe(3);  // seq 3 has pos=3000, first >= 2500
    expect(view.findFirst('pos', 9000n)).toBe(9);
    expect(view.findFirst('pos', 9001n)).toBe(-1);
  });

  it('accepts a number target for an i64 field (auto-coerces to bigint)', () => {
    const { view, writer } = makeSeekBuf({
      capacity: 32,
      fields: [{ name: 'pos', type: 'i64', flags: FIELD_FLAG_SORTED_ASC }],
    });
    writer.writeRecordBatch(
      Array.from({ length: 5 }, (_, i) => ({ pos: BigInt(i * 100) })),
    );

    // Passing a JS number for an i64 field should still work.
    expect(view.findFirst('pos', 150)).toBe(2); // pos=200 is first >= 150
  });

  it('works with f64 fields', () => {
    const { view, writer } = makeSeekBuf({
      capacity: 32,
      fields: [{ name: 'score', type: 'f64', flags: FIELD_FLAG_SORTED_ASC }],
    });
    writer.writeRecordBatch(
      Array.from({ length: 5 }, (_, i) => ({ score: i * 0.5 })), // 0, 0.5, 1.0, 1.5, 2.0
    );

    expect(view.findFirst('score', 0.75)).toBe(2); // seq 2 has score=1.0, first >= 0.75
    expect(view.findFirst('score', 2.0)).toBe(4);
    expect(view.findFirst('score', 2.1)).toBe(-1);
  });
});

// ─── error cases ─────────────────────────────────────────────────────────────

describe('findFirst — error cases', () => {
  it('throws TypeError for an unknown field name', () => {
    const { view } = makeSeekBuf({ capacity: 16 });
    expect(() => view.findFirst('nonexistent', 0)).toThrow(TypeError);
  });

  it('throws TypeError when the field lacks FIELD_FLAG_SORTED_ASC', () => {
    const { view, writer } = makeSeekBuf({
      capacity: 16,
      // 'id' has no SORTED flag
      fields: [
        { name: 'id',  type: 'u32' },
        { name: 'pos', type: 'u32', flags: FIELD_FLAG_SORTED_ASC },
      ],
    });
    writeLinear(writer, 4);

    expect(() => view.findFirst('id', 0)).toThrow(TypeError);
    expect(() => view.findFirst('pos', 0)).not.toThrow(); // sorted field is fine
  });

  it('throws TypeError for a non-numeric sorted field (utf8)', () => {
    // utf8 with SORTED_ASC is schema-legal but not binary-searchable here.
    const { view, writer } = makeSeekBuf({
      capacity: 16,
      fields:   [{ name: 'label', type: 'utf8', flags: FIELD_FLAG_SORTED_ASC }],
      heapCapacity: 1024,
    });
    writer.writeRecordBatch([{ label: 'a' }, { label: 'b' }]);

    expect(() => view.findFirst('label', 0)).toThrow(TypeError);
  });

  it('throws TypeError for utf8_ref with SORTED_ASC', () => {
    const { view, writer } = makeSeekBuf({
      capacity: 16,
      fields:   [{ name: 'chrom', type: 'utf8_ref', flags: FIELD_FLAG_SORTED_ASC }],
    });
    writer.writeRecordBatch([{ chrom: 0 }]);

    expect(() => view.findFirst('chrom', 0)).toThrow(TypeError);
  });
});
