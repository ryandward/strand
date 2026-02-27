/**
 * @strand/core — v4 Producer Metadata Region
 *
 * Tests for the optional metadata stored in the unused header tail:
 *   [92 + schema_byte_len .. 511]  →  [meta_byte_len: u32][meta_bytes: UTF-8 JSON]
 *
 * A non-JS producer (Rust, WASM) can pass intern tables, query context, or
 * any structured data through the header without a side-channel JSON payload.
 * StrandView.meta exposes the parsed value on the consumer side.
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
  { name: 'id',   type: 'u32' },
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

describe('producer metadata (v4) — basic round-trip', () => {

  it('readStrandHeader returns meta when initStrandHeader is given meta', () => {
    const map  = makeMap();
    const sab  = new SharedArrayBuffer(map.total_bytes);
    const meta = { internTable: ['chr1', 'chr2', 'chrM'], query: { start: 0, end: 500_000 } };

    initStrandHeader(sab, map, meta);
    const out = readStrandHeader(sab);

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

  it('meta is absent when not supplied', () => {
    const map = makeMap();
    const sab = new SharedArrayBuffer(map.total_bytes);

    initStrandHeader(sab, map);
    const out = readStrandHeader(sab);

    expect(out.meta).toBeUndefined();
  });

  it('meta is absent on a view constructed without meta', () => {
    const map  = makeMap();
    const sab  = new SharedArrayBuffer(map.total_bytes);
    initStrandHeader(sab, map);
    const view = new StrandView(sab);
    expect(view.map.meta).toBeUndefined();
  });

});

// ─── Group 2: value types ─────────────────────────────────────────────────────

describe('producer metadata (v4) — value types', () => {

  function roundTrip(meta: unknown): unknown {
    const map = makeMap();
    const sab = new SharedArrayBuffer(map.total_bytes);
    initStrandHeader(sab, map, meta);
    return readStrandHeader(sab).meta;
  }

  it('string meta', () => {
    expect(roundTrip('hello strand')).toBe('hello strand');
  });

  it('number meta', () => {
    expect(roundTrip(42)).toBe(42);
  });

  it('null meta produces absent meta (meta_byte_len = 0)', () => {
    // JSON.stringify(null) = "null" — a 4-byte payload; round-trips correctly.
    expect(roundTrip(null)).toBeNull();
  });

  it('array meta', () => {
    const table = ['chr1', 'chr2', 'chr3', 'chrX', 'chrY', 'chrM'];
    expect(roundTrip(table)).toEqual(table);
  });

  it('object meta with nested structure', () => {
    const meta = {
      query:      { assembly: 'hg38', chrom: 'chr17', start: 7_674_220, end: 7_674_893 },
      internTable: ['PASS', 'LowQual', 'SnpCluster'],
      version:    1,
    };
    expect(roundTrip(meta)).toEqual(meta);
  });

});

// ─── Group 3: boundary conditions ────────────────────────────────────────────

describe('producer metadata (v4) — boundary conditions', () => {

  it('meta that exactly fills available header space is accepted', () => {
    const map        = makeMap();
    const sab        = new SharedArrayBuffer(map.total_bytes);
    const schemaBytes = 2 + schema.fields.reduce((acc, f) => {
      const nameLen = new TextEncoder().encode(f.name).length;
      return acc + Math.ceil((5 + nameLen) / 4) * 4;
    }, 0);
    // Available: 512 − (92 + schemaBytes) − 4 (meta_byte_len) bytes for JSON text.
    const available  = 512 - 92 - schemaBytes - 4;
    // A JSON string of exactly `available` bytes: "\"" + "x".repeat(available-2) + "\""
    const payload    = 'x'.repeat(available - 2); // -2 for surrounding quotes in JSON
    const meta       = payload;                    // JSON.stringify("xxx...") = "\"xxx...\""

    expect(() => initStrandHeader(sab, map, meta)).not.toThrow();
    expect(readStrandHeader(sab).meta).toBe(payload);
  });

  it('meta that overflows header throws StrandHeaderError', () => {
    const map  = makeMap();
    const sab  = new SharedArrayBuffer(map.total_bytes);
    // Build a string whose JSON encoding exceeds available space.
    const big  = 'z'.repeat(600); // WAY more than 420 bytes of available tail
    expect(() => initStrandHeader(sab, map, big)).toThrow(StrandHeaderError);
  });

  it('undefined meta is treated as absent', () => {
    const map = makeMap();
    const sab = new SharedArrayBuffer(map.total_bytes);
    initStrandHeader(sab, map, undefined);
    expect(readStrandHeader(sab).meta).toBeUndefined();
  });

});
