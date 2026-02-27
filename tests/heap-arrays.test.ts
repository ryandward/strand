/**
 * @strand/core — Phase 4 RED Tests: Variable-Length Typed Arrays
 *
 * Problem: genomic data relies heavily on numeric arrays (VCF FORMAT fields,
 * base qualities, coverage windows). Currently, utf8 is our only heap type.
 *
 * New types:
 *   bytes      → Uint8Array    — raw byte array, 1-byte aligned (no padding needed)
 *   i32_array  → Int32Array    — signed 32-bit integers, 4-byte aligned
 *   f32_array  → Float32Array  — single-precision floats,  4-byte aligned
 *
 * Wire format in the index record (same as utf8/json):
 *   [heap_offset: u32][heap_len: u16]  (6 bytes)
 *   heap_len = element_count × element_size  (bytes, not elements)
 *
 * The Alignment Trap:
 *   Float32Array and Int32Array require their buffer to start at a 4-byte
 *   aligned absolute byte offset within the SAB. claimHeap() currently packs
 *   bytes tightly — no alignment padding is performed.
 *
 *   If a 3-byte utf8 string is written first, HEAP_WRITE advances to 3.
 *   The next claimHeap() returns physOffset = 3. Constructing
 *   new Float32Array(sab, heapStart + 3, count) throws immediately:
 *     RangeError: byte offset is not aligned to element size
 *
 * All tests are INTENTIONALLY RED until Phase 4 is implemented in src/.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSchema,
  computeStrandMap,
  initStrandHeader,
  StrandView,
  StrandWriter,
} from '../src/index';

// ─── Helper ───────────────────────────────────────────────────────────────────
//
// Accepts `type: string` (not FieldType) so tests can pass unknown types
// like 'f32_array' without a per-call @ts-expect-error.

function makeArrayBuf(
  fields: Array<{ name: string; type: string; flags?: number }>,
  opts: { capacity?: number; heapCapacity?: number } = {},
) {
  const capacity = opts.capacity ?? 32;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = buildSchema(fields as any);
  const map    = computeStrandMap({
    schema,
    index_capacity:    capacity,
    heap_capacity:     opts.heapCapacity ?? 2048,
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

// ─── Group 1: f32_array ───────────────────────────────────────────────────────

describe('Phase 4 — f32_array', () => {

  it('buildSchema assigns a 6-byte index footprint to f32_array', () => {
    //
    // f32_array uses the same [heap_offset: u32][heap_len: u16] wire format
    // as utf8. FIELD_BYTE_WIDTHS['f32_array'] must equal 6.
    //
    // CURRENTLY FAILS:
    //   FIELD_BYTE_WIDTHS['f32_array'] is undefined.
    //   width = undefined → alignment = NaN → record_stride = NaN.
    //   computeStrandMap receives NaN stride → SharedArrayBuffer(NaN) throws
    //   RangeError: SharedArrayBuffer length must be a finite non-negative integer.
    //
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = buildSchema([{ name: 'vals', type: 'f32_array' }] as any);
    const field  = schema.fields.find(f => f.name === 'vals')!;
    expect(field.byteOffset).toBeGreaterThanOrEqual(0);
    // stride = bitmapBytes + 6 (heap ptr) rounded to 4-byte boundary = 8
    expect(schema.record_stride).toBe(8);
  });

  it('basic write and read: Float32Array round-trip (physOffset = 0, always aligned)', () => {
    //
    // With only one f32_array field and a fresh heap (offset = 0), the
    // physical address is heapStart + 0 — guaranteed 4-byte aligned.
    // This is the simple case with no alignment hazard.
    //
    // CURRENTLY FAILS: 'f32_array' is not in FieldType → NaN stride → throws.
    //
    const { view, writer } = makeArrayBuf(
      [{ name: 'vals', type: 'f32_array' }],
      { heapCapacity: 256 },
    );

    writer.writeRecordBatch([{ vals: new Float32Array([1.5, 2.5, 3.5]) }]);

    const cursor = view.allocateCursor();
    cursor.seek(0);
    // @ts-expect-error — getF32Array not yet implemented on RecordCursor
    const arr = cursor.getF32Array('vals');
    expect(arr).not.toBeNull();
    expect(arr).toBeInstanceOf(Float32Array);
    expect(Array.from(arr!)).toEqual([1.5, 2.5, 3.5]);
  });

  it('null f32_array is written as a zero-length heap entry and reads back as null', () => {
    //
    // Mirrors utf8 null behaviour: heap_len = 0 in the index record → null.
    //
    // CURRENTLY FAILS: same NaN stride reason as above.
    //
    const { view, writer } = makeArrayBuf(
      [{ name: 'vals', type: 'f32_array' }],
      { heapCapacity: 256 },
    );

    writer.writeRecordBatch([{ vals: null }]);

    const cursor = view.allocateCursor();
    cursor.seek(0);
    // @ts-expect-error
    expect(cursor.getF32Array('vals')).toBeNull();
  });

});

// ─── Group 2: The Alignment Trap ─────────────────────────────────────────────

describe('Phase 4 — heap alignment trap', () => {

  it('f32_array after a 3-byte utf8 string must be 4-byte aligned (not crash)', () => {
    //
    // This is the core regression test for Phase 4.
    //
    // Write sequence:
    //   Record 0: tag = 'ACG'  (3 bytes) → HEAP_WRITE: 0 → 3
    //   Record 1: my_array = [1.5, 2.5, 3.5]
    //             → claimHeap(12) returns physOffset = 3 (unaligned!)
    //             → new Float32Array(sab, heapStart + 3, 3) throws:
    //               RangeError: byte offset is not aligned to element size
    //
    // After the fix, claimHeap must accept an alignment parameter and pad
    // HEAP_WRITE from 3 → 4 before claiming, so physOffset = 4 (aligned).
    //
    // CURRENTLY FAILS: 'f32_array' not in FieldType → NaN stride → throws
    //   before even reaching the write path.
    // AFTER TYPE IS ADDED but before alignment fix: throws RangeError at
    //   Float32Array construction during getF32Array('my_array').
    //
    const { view, writer } = makeArrayBuf(
      [
        { name: 'tag',      type: 'utf8'      },
        { name: 'my_array', type: 'f32_array' },
      ],
      { heapCapacity: 256 },
    );

    writer.writeRecordBatch([
      { tag: 'ACG', my_array: null                            },
      { tag: null,  my_array: new Float32Array([1.5, 2.5, 3.5]) },
    ]);

    const cursor = view.allocateCursor();

    cursor.seek(0);
    expect(cursor.getString('tag')).toBe('ACG');

    cursor.seek(1);
    // @ts-expect-error — getF32Array not yet implemented
    const arr = cursor.getF32Array('my_array');
    expect(arr).not.toBeNull();
    expect(arr).toBeInstanceOf(Float32Array);
    expect(Array.from(arr!)).toEqual([1.5, 2.5, 3.5]);
  });

});

// ─── Group 3: bytes (Uint8Array) ─────────────────────────────────────────────

describe('Phase 4 — bytes', () => {

  it('basic write and read: Uint8Array round-trip', () => {
    //
    // bytes is 1-byte aligned — claimHeap needs no padding for this type.
    // The accessor returns a zero-copy view into the SAB heap region.
    //
    // CURRENTLY FAILS: 'bytes' not in FieldType → NaN stride → throws.
    //
    const { view, writer } = makeArrayBuf(
      [{ name: 'qual', type: 'bytes' }],
      { heapCapacity: 256 },
    );

    const phredScores = new Uint8Array([37, 40, 35, 28, 42]);
    writer.writeRecordBatch([{ qual: phredScores }]);

    const cursor = view.allocateCursor();
    cursor.seek(0);
    // @ts-expect-error — getBytes not yet implemented on RecordCursor
    const result = cursor.getBytes('qual');
    expect(result).not.toBeNull();
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result!)).toEqual([37, 40, 35, 28, 42]);
  });

  it('bytes after a 3-byte utf8 string has no alignment issue (1-byte aligned)', () => {
    //
    // Uint8Array requires no alignment — physOffset = 3 is valid for a Uint8Array.
    // This test confirms bytes works immediately after an odd-byte utf8 write.
    //
    // CURRENTLY FAILS: 'bytes' not in FieldType → NaN stride → throws.
    //
    const { view, writer } = makeArrayBuf(
      [
        { name: 'tag',  type: 'utf8'  },
        { name: 'qual', type: 'bytes' },
      ],
      { heapCapacity: 256 },
    );

    writer.writeRecordBatch([
      { tag: 'ACG', qual: null                          },
      { tag: null,  qual: new Uint8Array([10, 20, 30]) },
    ]);

    const cursor = view.allocateCursor();
    cursor.seek(1);
    // @ts-expect-error
    const result = cursor.getBytes('qual');
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual([10, 20, 30]);
  });

});

// ─── Group 4: i32_array ───────────────────────────────────────────────────────

describe('Phase 4 — i32_array', () => {

  it('basic write and read: Int32Array round-trip', () => {
    //
    // CURRENTLY FAILS: 'i32_array' not in FieldType → NaN stride → throws.
    //
    const { view, writer } = makeArrayBuf(
      [{ name: 'depths', type: 'i32_array' }],
      { heapCapacity: 256 },
    );

    writer.writeRecordBatch([{ depths: new Int32Array([100, 200, -1, 50]) }]);

    const cursor = view.allocateCursor();
    cursor.seek(0);
    // @ts-expect-error — getI32Array not yet implemented
    const result = cursor.getI32Array('depths');
    expect(result).not.toBeNull();
    expect(result).toBeInstanceOf(Int32Array);
    expect(Array.from(result!)).toEqual([100, 200, -1, 50]);
  });

  it('i32_array after a 2-byte utf8 string must be 4-byte aligned (not crash)', () => {
    //
    // Record 0: tag = 'AT' (2 bytes) → HEAP_WRITE: 0 → 2
    // Record 1: depths = [10, 20]
    //           → physOffset = 2 (unaligned for Int32Array!)
    //           → new Int32Array(sab, heapStart + 2, 2) throws
    //
    // After fix: claimHeap pads 2 bytes → physOffset = 4 (aligned).
    //
    // CURRENTLY FAILS: 'i32_array' not in FieldType.
    //
    const { view, writer } = makeArrayBuf(
      [
        { name: 'tag',    type: 'utf8'      },
        { name: 'depths', type: 'i32_array' },
      ],
      { heapCapacity: 256 },
    );

    writer.writeRecordBatch([
      { tag: 'AT',  depths: null                     },
      { tag: null,  depths: new Int32Array([10, 20]) },
    ]);

    const cursor = view.allocateCursor();
    cursor.seek(1);
    // @ts-expect-error
    const result = cursor.getI32Array('depths');
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual([10, 20]);
  });

});

// ─── Group 5: heap wrap + alignment ──────────────────────────────────────────

describe('Phase 4 — heap wrap + alignment', () => {

  it('f32_array written after a heap wrap lands at a 4-byte-aligned physOffset', () => {
    //
    // Fill the heap to within 3 bytes of the wrap boundary, then write
    // an f32_array. The array must wrap to physOffset = 0 (always aligned),
    // OR the wrap skip must land us at an aligned post-wrap offset.
    //
    // Heap capacity: 128 bytes.
    // Record 0: 'A'.repeat(61) = 61 bytes → HEAP_WRITE = 61
    // Record 1: 'B'.repeat(61) = 61 bytes → HEAP_WRITE = 122  (6 bytes from end)
    // Record 2: f32_array [9.9, 8.8] = 8 bytes → does not fit in 6 bytes remaining
    //           → must wrap. physOffset = 0. Float32Array(sab, heapStart + 0, 2) — aligned.
    //
    // CURRENTLY FAILS: 'f32_array' not in FieldType → NaN stride → throws.
    //
    const { view, writer } = makeArrayBuf(
      [
        { name: 'pad',  type: 'utf8'      },
        { name: 'vals', type: 'f32_array' },
      ],
      { capacity: 32, heapCapacity: 128 },
    );

    writer.writeRecordBatch([
      { pad: 'A'.repeat(61), vals: null },
      { pad: 'B'.repeat(61), vals: null },
    ]);

    writer.writeRecordBatch([
      { pad: null, vals: new Float32Array([9.9, 8.8]) },
    ]);

    const cursor = view.allocateCursor();
    cursor.seek(2);
    // @ts-expect-error
    const arr = cursor.getF32Array('vals');
    expect(arr).not.toBeNull();
    expect(arr![0]).toBeCloseTo(9.9);
    expect(arr![1]).toBeCloseTo(8.8);
  });

});
