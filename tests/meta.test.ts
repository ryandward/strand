/**
 * @strand/core — v5 Producer Metadata Region
 *
 * Tests for the optional metadata stored in the header tail:
 *   [92 + schema_byte_len .. 4095]  →  [meta_byte_len: u32][meta_bytes: UTF-8 JSON]
 *
 * In v5, field names are stripped from binary schema bytes and carried as a
 * `columns` string array auto-injected into metadata by initStrandHeader().
 * readStrandHeader() extracts `columns` to reconstruct named FieldDescriptors,
 * then strips `columns` from the user-visible StrandMap.meta.
 *
 * A non-JS producer (Rust, WASM) can additionally embed intern tables, query
 * context, or any plain-object metadata — merged alongside `columns`.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSchema,
  computeStrandMap,
  initStrandHeader,
  readStrandHeader,
  StrandView,
  StrandHeaderError,
} from '../src/index';

// Minimal schema used across all tests.
const schema = buildSchema([
  { name: 'id',    type: 'u32' },
  { name: 'score', type: 'f32' },
]);

function makeMap() {
  return computeStrandMap({
    schema,
    index_capacity: 64,
    heap_capacity:  4096,
    query: { assembly: 'hg38', chrom: 'chr1', start: 0, end: 1_000_000 },
    estimated_records: 64,
  });
}

// ─── Group 1: basic round-trip ───────────────────────────────────────────────

describe('producer metadata (v5) — basic round-trip', () => {

  it('readStrandHeader returns meta when initStrandHeader is given a meta object', () => {
    const map  = makeMap();
    const sab  = new SharedArrayBuffer(map.total_bytes);
    const meta = { internTable: ['chr1', 'chr2', 'chrM'], query: { start: 0, end: 500_000 } };

    initStrandHeader(sab, map, meta);
    const out = readStrandHeader(sab);

    // columns is stripped from user-visible meta; user-supplied keys remain.
    expect(out.meta).toEqual(meta);
  });

  it('StrandView.meta exposes the metadata', () => {
    const map  = makeMap();
    const sab  = new SharedArrayBuffer(map.total_bytes);
    const meta = { lanes: 4, calibration: [1.0, 2.0, 3.0] };

    initStrandHeader(sab, map, meta);
    const view = new StrandView(sab);

    expect(view.map.meta).toEqual(meta);
  });

  it('meta is absent when no caller meta is supplied (columns injected and stripped)', () => {
    // columns is auto-injected into the header but stripped from StrandMap.meta.
    const map = makeMap();
    const sab = new SharedArrayBuffer(map.total_bytes);

    initStrandHeader(sab, map);
    const out = readStrandHeader(sab);

    expect(out.meta).toBeUndefined();
  });

  it('meta is absent on a StrandView constructed without caller meta', () => {
    const map  = makeMap();
    const sab  = new SharedArrayBuffer(map.total_bytes);
    initStrandHeader(sab, map);
    const view = new StrandView(sab);
    expect(view.map.meta).toBeUndefined();
  });

  it('schema fields have real names after round-trip (columns reconstructs names)', () => {
    const map = makeMap();
    const sab = new SharedArrayBuffer(map.total_bytes);
    initStrandHeader(sab, map);
    const out = readStrandHeader(sab);

    expect(out.schema.fields.map(f => f.name)).toEqual(['id', 'score']);
  });

});

// ─── Group 2: object meta merges with columns ─────────────────────────────────

describe('producer metadata (v5) — object meta merging', () => {

  it('object meta with nested structure round-trips (columns stripped from meta)', () => {
    const meta = {
      query:       { assembly: 'hg38', chrom: 'chr17', start: 7_674_220, end: 7_674_893 },
      internTable: ['PASS', 'LowQual', 'SnpCluster'],
      version:     1,
    };
    const map = makeMap();
    const sab = new SharedArrayBuffer(map.total_bytes);
    initStrandHeader(sab, map, meta);
    const out = readStrandHeader(sab);

    expect(out.meta).toEqual(meta);
    // columns should not appear in user-visible meta.
    expect((out.meta as Record<string, unknown>)['columns']).toBeUndefined();
  });

  it('columns always appear in schema.fields even when meta object is provided', () => {
    const meta = { internTable: ['chr1', 'chr2'] };
    const map = makeMap();
    const sab = new SharedArrayBuffer(map.total_bytes);
    initStrandHeader(sab, map, meta);
    const out = readStrandHeader(sab);

    expect(out.schema.fields.map(f => f.name)).toEqual(['id', 'score']);
  });

});

// ─── Group 3: non-object meta is ignored ──────────────────────────────────────

describe('producer metadata (v5) — non-object meta ignored', () => {

  // Non-object meta values cannot be merged with the auto-injected columns object.
  // Only columns are written; StrandMap.meta is absent after stripping columns.

  it('string meta is ignored; schema field names still round-trip', () => {
    const map = makeMap();
    const sab = new SharedArrayBuffer(map.total_bytes);
    initStrandHeader(sab, map, 'hello strand');
    const out = readStrandHeader(sab);

    expect(out.meta).toBeUndefined();
    expect(out.schema.fields.map(f => f.name)).toEqual(['id', 'score']);
  });

  it('number meta is ignored', () => {
    const map = makeMap();
    const sab = new SharedArrayBuffer(map.total_bytes);
    initStrandHeader(sab, map, 42);
    const out = readStrandHeader(sab);

    expect(out.meta).toBeUndefined();
  });

  it('null meta is ignored', () => {
    const map = makeMap();
    const sab = new SharedArrayBuffer(map.total_bytes);
    initStrandHeader(sab, map, null);
    const out = readStrandHeader(sab);

    expect(out.meta).toBeUndefined();
  });

  it('array meta is ignored', () => {
    const map = makeMap();
    const sab = new SharedArrayBuffer(map.total_bytes);
    initStrandHeader(sab, map, ['chr1', 'chr2', 'chr3']);
    const out = readStrandHeader(sab);

    expect(out.meta).toBeUndefined();
  });

  it('undefined meta produces absent StrandMap.meta', () => {
    const map = makeMap();
    const sab = new SharedArrayBuffer(map.total_bytes);
    initStrandHeader(sab, map, undefined);
    expect(readStrandHeader(sab).meta).toBeUndefined();
  });

});

// ─── Group 4: boundary conditions ────────────────────────────────────────────

describe('producer metadata (v5) — boundary conditions', () => {

  it('large object meta that fits in the 4096-byte header is accepted', () => {
    // With HEADER_SIZE=4096, the metadata region is very generous.
    // A ~3000-byte JSON payload should fit comfortably.
    const map  = makeMap();
    const sab  = new SharedArrayBuffer(map.total_bytes);
    const meta = { data: 'x'.repeat(2000), table: ['a', 'b', 'c'] };

    expect(() => initStrandHeader(sab, map, meta)).not.toThrow();
    const out = readStrandHeader(sab);
    expect(out.meta).toEqual(meta);
  });

  it('meta that overflows the 4096-byte header throws StrandHeaderError', () => {
    const map = makeMap();
    const sab = new SharedArrayBuffer(map.total_bytes);
    // 5000 chars of data JSON-encodes to ~5013 bytes; plus columns overhead
    // and schema bytes exceeds the ~3900 bytes available in the tail.
    const big = { data: 'z'.repeat(5000) };
    expect(() => initStrandHeader(sab, map, big)).toThrow(StrandHeaderError);
  });

});
