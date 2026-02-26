/**
 * @strand/core — header initialization and validation
 *
 * The Strand header occupies the first 512 bytes of every SharedArrayBuffer
 * managed by this library. It contains:
 *
 *   Static geometry  — magic, version, schema fingerprint, ring capacities,
 *                      and a CRC of those six fields (header_crc)
 *   Atomics words    — seven i32 cursors (including CTRL_ABORT)
 *   Schema bytes     — binary-encoded BinarySchemaDescriptor
 *
 * initStrandHeader()  — called once by the party that allocates the SAB.
 *                       Safe to call before sharing the SAB with any Worker.
 * readStrandHeader()  — called by consumers (StrandView, Workers) to validate
 *                       and reconstruct the StrandMap from the binary header.
 * computeStrandMap()  — server-side convenience: build a StrandMap from
 *                       schema + sizing parameters.
 */

import {
  STRAND_MAGIC,
  STRAND_VERSION,
  HEADER_SIZE,
  MAX_SCHEMA_BYTES,
  OFFSET_MAGIC,
  OFFSET_VERSION,
  OFFSET_SCHEMA_FP,
  OFFSET_RECORD_STRIDE,
  OFFSET_INDEX_CAPACITY,
  OFFSET_HEAP_CAPACITY,
  OFFSET_HEADER_CRC,
  OFFSET_SCHEMA_BYTE_LEN,
  OFFSET_SCHEMA_BYTES,
  CTRL_ARRAY_LEN,
  CTRL_WRITE_SEQ,
  CTRL_COMMIT_SEQ,
  CTRL_READ_CURSOR,
  CTRL_STATUS,
  CTRL_HEAP_WRITE,
  CTRL_HEAP_COMMIT,
  CTRL_ABORT,
  STATUS_INITIALIZING,
  computeTotalBytes,
} from './constants';
import { encodeSchema, decodeSchema, schemaFingerprint } from './schema';
import type { StrandMap, BinarySchemaDescriptor } from './types';

// ─── Errors ───────────────────────────────────────────────────────────────────

export class StrandHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrandHeaderError';
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * FNV-1a 32-bit hash — inlined here to avoid cross-module coupling.
 * Used exclusively for computing and validating the header geometry CRC.
 */
function fnv1a32(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash  = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Compute the header geometry CRC from the six static fields (bytes 0–23).
 * Written at OFFSET_HEADER_CRC by initStrandHeader; re-computed and compared
 * by readStrandHeader before any geometry value is used.
 */
function computeHeaderCRC(sab: SharedArrayBuffer): number {
  return fnv1a32(new Uint8Array(sab, 0, OFFSET_HEADER_CRC));
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

// ─── initStrandHeader ─────────────────────────────────────────────────────────

/**
 * Write the Strand header into a freshly allocated SharedArrayBuffer.
 *
 * Pre-conditions (enforced; throws StrandHeaderError on violation):
 *   - Platform must be little-endian (BE systems are unsupported)
 *   - sab.byteLength >= map.total_bytes
 *   - map.index_capacity is a power of 2
 *   - map.record_stride is 4-byte aligned
 *   - Binary schema fits in the 452-byte header region
 *   - map.schema_fingerprint matches the actual fingerprint of map.schema
 *
 * Writes static fields, computes and stores header_crc, then initializes
 * all seven Atomics control words to zero with Atomics.store (release
 * semantics). Any Worker that receives this SAB via postMessage after
 * initStrandHeader returns will see the correctly initialized header.
 *
 * Call this exactly once, before sharing the SAB with any Worker.
 */
export function initStrandHeader(sab: SharedArrayBuffer, map: StrandMap): void {

  // ── Pre-flight: endianness ─────────────────────────────────────────────────
  //
  // All multi-byte DataView reads/writes in @strand/core use explicit
  // little-endian (true). The Atomics control words are accessed via
  // Int32Array, which uses native byte order — but since producer and
  // consumer always share the same process, their native order is always
  // identical regardless of platform.
  //
  // However, we still refuse big-endian as a defensive measure: running on a
  // BE system would mean a future code path might mix DataView-LE and
  // TypedArray-BE interpretations of the same header bytes, producing
  // silent data corruption that is very hard to debug.
  //
  // The probe byte sequence [0x01, 0x00] reads as 0x0001 on LE and 0x0100 on BE.
  if (new Uint16Array(new Uint8Array([0x01, 0x00]).buffer)[0] !== 1) {
    throw new StrandHeaderError(
      '@strand/core requires a little-endian system. ' +
      'Big-endian platforms are not supported in v' + STRAND_VERSION + '.',
    );
  }

  // ── Pre-flight: size ───────────────────────────────────────────────────────

  if (sab.byteLength < HEADER_SIZE) {
    throw new StrandHeaderError(
      `SharedArrayBuffer too small: ${sab.byteLength} bytes; ` +
      `need at least ${HEADER_SIZE} for the header alone.`,
    );
  }

  const expectedTotal = computeTotalBytes(
    map.index_capacity,
    map.record_stride,
    map.heap_capacity,
  );
  if (sab.byteLength < expectedTotal) {
    throw new StrandHeaderError(
      `SharedArrayBuffer too small for this StrandMap: ` +
      `need ${expectedTotal} bytes ` +
      `(header:${HEADER_SIZE} + index:${map.index_capacity * map.record_stride} + heap:${map.heap_capacity}), ` +
      `got ${sab.byteLength}.`,
    );
  }

  // ── Pre-flight: alignment ──────────────────────────────────────────────────

  if (!isPowerOfTwo(map.index_capacity)) {
    throw new StrandHeaderError(
      `index_capacity must be a power of 2 for O(1) ring arithmetic; ` +
      `got ${map.index_capacity}.`,
    );
  }

  if (map.record_stride % 4 !== 0) {
    throw new StrandHeaderError(
      `record_stride must be 4-byte aligned for DataView alignment safety; ` +
      `got ${map.record_stride}.`,
    );
  }

  // ── Pre-flight: schema ─────────────────────────────────────────────────────

  const schemaBytes = encodeSchema(map.schema);
  if (schemaBytes.length > MAX_SCHEMA_BYTES) {
    throw new StrandHeaderError(
      `Schema binary encoding is ${schemaBytes.length} bytes; ` +
      `maximum that fits in the header is ${MAX_SCHEMA_BYTES} bytes. ` +
      `Reduce field count or shorten field names.`,
    );
  }

  // Reject a StrandMap whose fingerprint disagrees with its schema.
  const actualFp = schemaFingerprint(map.schema);
  if (actualFp !== map.schema_fingerprint) {
    throw new StrandHeaderError(
      `schema_fingerprint mismatch: ` +
      `StrandMap declares 0x${map.schema_fingerprint.toString(16).padStart(8, '0')}, ` +
      `but schema encodes to    0x${actualFp.toString(16).padStart(8, '0')}. ` +
      `Use computeStrandMap() to derive the fingerprint automatically.`,
    );
  }

  // ── Write static fields via DataView ──────────────────────────────────────

  const view = new DataView(sab);

  view.setUint32(OFFSET_MAGIC,           STRAND_MAGIC,           /* le */ true);
  view.setUint32(OFFSET_VERSION,         STRAND_VERSION,                  true);
  view.setUint32(OFFSET_SCHEMA_FP,       map.schema_fingerprint,          true);
  view.setUint32(OFFSET_RECORD_STRIDE,   map.record_stride,               true);
  view.setUint32(OFFSET_INDEX_CAPACITY,  map.index_capacity,              true);
  view.setUint32(OFFSET_HEAP_CAPACITY,   map.heap_capacity,               true);

  // ── Write header CRC ───────────────────────────────────────────────────────
  //
  // The CRC covers bytes 0–23 (the six static geometry fields written above).
  // It is the last static field written so that the six geometry values are
  // already stable when the hash is computed. readStrandHeader re-computes
  // the same hash before using any geometry value, catching rogue-pointer
  // corruption of index_capacity, record_stride, or heap_capacity.

  view.setUint32(OFFSET_HEADER_CRC, computeHeaderCRC(sab), true);

  // ── Write schema ───────────────────────────────────────────────────────────

  view.setUint32(OFFSET_SCHEMA_BYTE_LEN, schemaBytes.length, true);
  new Uint8Array(sab, OFFSET_SCHEMA_BYTES, schemaBytes.length).set(schemaBytes);

  // ── Initialize Atomics control words ──────────────────────────────────────
  //
  // Atomics.store — not plain assignment — because the SAB may be shared by
  // the time this function returns. Atomics.store provides release semantics:
  // any Worker receiving the SAB via postMessage will observe these values.

  const ctrl = new Int32Array(sab, 0, CTRL_ARRAY_LEN);

  Atomics.store(ctrl, CTRL_WRITE_SEQ,   0);
  Atomics.store(ctrl, CTRL_COMMIT_SEQ,  0);
  Atomics.store(ctrl, CTRL_READ_CURSOR, 0);
  Atomics.store(ctrl, CTRL_STATUS,      STATUS_INITIALIZING);
  Atomics.store(ctrl, CTRL_HEAP_WRITE,  0);
  Atomics.store(ctrl, CTRL_HEAP_COMMIT, 0);
  Atomics.store(ctrl, CTRL_ABORT,       0);
}

// ─── readStrandHeader ─────────────────────────────────────────────────────────

/**
 * Read and strictly validate the Strand header in a SharedArrayBuffer.
 *
 * Throws StrandHeaderError on:
 *   - Magic mismatch        (buffer was not written by @strand/core)
 *   - Version mismatch      (written by an incompatible version)
 *   - Header CRC mismatch   (geometry fields corrupted since initStrandHeader)
 *   - Corrupt schema        (truncated or unknown type tags)
 *   - Fingerprint mismatch  (schema bytes inconsistent with stored fingerprint)
 *
 * Validation order is fastest-to-detect-corruption first:
 *   magic → version → header_crc → schema decode → schema fingerprint
 */
export function readStrandHeader(sab: SharedArrayBuffer): StrandMap {
  if (sab.byteLength < HEADER_SIZE) {
    throw new StrandHeaderError(
      `SharedArrayBuffer is ${sab.byteLength} bytes; ` +
      `a Strand header requires at least ${HEADER_SIZE}.`,
    );
  }

  const view = new DataView(sab);

  // ── Magic ──────────────────────────────────────────────────────────────────

  const magic = view.getUint32(OFFSET_MAGIC, true);
  if (magic !== STRAND_MAGIC) {
    const hex = `0x${magic.toString(16).toUpperCase().padStart(8, '0')}`;
    throw new StrandHeaderError(
      `Invalid magic: got ${hex}; expected 0x${STRAND_MAGIC.toString(16).toUpperCase()} ('STRN'). ` +
      `This SharedArrayBuffer was not initialized by @strand/core.`,
    );
  }

  // ── Version ────────────────────────────────────────────────────────────────

  const version = view.getUint32(OFFSET_VERSION, true);
  if (version !== STRAND_VERSION) {
    throw new StrandHeaderError(
      `Unsupported Strand version ${version}. ` +
      `This build of @strand/core supports version ${STRAND_VERSION} only. ` +
      `Update @strand/core to read version-${version} buffers.`,
    );
  }

  // ── Header CRC ────────────────────────────────────────────────────────────
  //
  // Re-compute the FNV-1a hash of the six static geometry fields (bytes 0–23)
  // and compare to the stored checksum at OFFSET_HEADER_CRC. A mismatch means
  // a rogue pointer or memory safety bug has corrupted one of the geometry
  // fields since initStrandHeader ran. Halt before using any corrupt value.

  const storedCRC   = view.getUint32(OFFSET_HEADER_CRC, true);
  const computedCRC = computeHeaderCRC(sab);
  if (storedCRC !== computedCRC) {
    throw new StrandHeaderError(
      `Header geometry CRC mismatch: ` +
      `stored 0x${storedCRC.toString(16).padStart(8, '0')}, ` +
      `computed 0x${computedCRC.toString(16).padStart(8, '0')}. ` +
      `One of the static geometry fields (magic, version, schema_fp, ` +
      `record_stride, index_capacity, or heap_capacity) was corrupted ` +
      `after initStrandHeader().`,
    );
  }

  // ── Geometry ───────────────────────────────────────────────────────────────

  const schema_fingerprint = view.getUint32(OFFSET_SCHEMA_FP,       true);
  const record_stride      = view.getUint32(OFFSET_RECORD_STRIDE,    true);
  const index_capacity     = view.getUint32(OFFSET_INDEX_CAPACITY,   true);
  const heap_capacity      = view.getUint32(OFFSET_HEAP_CAPACITY,    true);
  const schema_byte_len    = view.getUint32(OFFSET_SCHEMA_BYTE_LEN,  true);

  if (schema_byte_len < 2) {
    throw new StrandHeaderError(
      `schema_byte_len ${schema_byte_len} is too small: ` +
      `minimum 2 bytes for the field_count u16. The header is corrupt.`,
    );
  }

  if (schema_byte_len > MAX_SCHEMA_BYTES) {
    throw new StrandHeaderError(
      `schema_byte_len ${schema_byte_len} exceeds header capacity ${MAX_SCHEMA_BYTES}. ` +
      `The header is corrupt.`,
    );
  }

  // ── Schema ─────────────────────────────────────────────────────────────────

  const schemaSlice = new Uint8Array(sab, OFFSET_SCHEMA_BYTES, schema_byte_len);
  const schema      = decodeSchema(schemaSlice);
  if (schema === null) {
    throw new StrandHeaderError(
      `Failed to decode schema descriptor (${schema_byte_len} bytes). ` +
      `The header is corrupt or was written by an incompatible version.`,
    );
  }

  if (schema.record_stride === 0) {
    throw new StrandHeaderError(
      `Decoded schema has record_stride = 0 (no fields or all zero-width fields). ` +
      `A valid Strand schema must have at least one field. The header is corrupt.`,
    );
  }

  // ── Fingerprint integrity ──────────────────────────────────────────────────

  const computedFp = schemaFingerprint(schema);
  if (computedFp !== schema_fingerprint) {
    throw new StrandHeaderError(
      `Schema fingerprint mismatch: ` +
      `header stores 0x${schema_fingerprint.toString(16).padStart(8, '0')}, ` +
      `decoded schema hashes to 0x${computedFp.toString(16).padStart(8, '0')}. ` +
      `The schema descriptor in the header is corrupt.`,
    );
  }

  // ── Stride coherence ───────────────────────────────────────────────────────
  //
  // decodeSchema() recomputes record_stride from field layout (high-water mark
  // of byteOffset + field_width, padded to 4 bytes). The geometry section
  // stores the stride independently. They must agree.
  //
  // A mismatch means either:
  //   a) A hand-crafted BinarySchemaDescriptor set record_stride < field layout
  //      (stride overflow — fields alias adjacent slots), or
  //   b) The geometry section was corrupted after initStrandHeader ran (caught
  //      by the CRC above for most cases, but the schema bytes are not CRC'd).
  //
  // If the decoded stride is larger, a writer using the geometry stride would
  // write slots too close together and a reader at byteOffset would alias into
  // the next slot — silent memory corruption.

  if (schema.record_stride !== record_stride) {
    throw new StrandHeaderError(
      `Schema stride mismatch: geometry header stores record_stride=${record_stride}, ` +
      `but field layout implies record_stride=${schema.record_stride}. ` +
      `The header is corrupt or was written with a hand-crafted schema descriptor.`,
    );
  }

  // ── Reconstruct StrandMap ──────────────────────────────────────────────────

  return {
    schema_fingerprint,
    record_stride,
    index_capacity,
    heap_capacity,
    total_bytes: computeTotalBytes(index_capacity, record_stride, heap_capacity),
    // Query context is not stored in the binary header.
    query: { assembly: '', chrom: '', start: 0, end: 0 },
    estimated_records: 0,
    schema,
  };
}

// ─── computeStrandMap ─────────────────────────────────────────────────────────

/**
 * Server-side convenience: build a validated StrandMap from a schema and sizing
 * parameters. Computes schema_fingerprint and total_bytes automatically.
 *
 * The returned StrandMap is ready to:
 *   1. Embed in HTML as window.__STRAND_MAP__
 *   2. Pass to initStrandHeader() to write the binary header
 */
export function computeStrandMap(params: {
  schema:            BinarySchemaDescriptor;
  index_capacity:    number;
  heap_capacity:     number;
  query:             StrandMap['query'];
  estimated_records: number;
}): StrandMap {
  const { schema, index_capacity, heap_capacity, query, estimated_records } = params;

  if (!isPowerOfTwo(index_capacity)) {
    throw new StrandHeaderError(
      `index_capacity must be a power of 2; got ${index_capacity}.`,
    );
  }

  if (query.start > query.end) {
    throw new RangeError(
      `query.start (${query.start}) must be ≤ query.end (${query.end}). ` +
      `A negative-length interval is not representable.`,
    );
  }

  const hasVarLen = schema.fields.some(f => f.type === 'utf8' || f.type === 'json');
  if (hasVarLen && heap_capacity === 0) {
    throw new RangeError(
      `Schema contains variable-length fields (utf8/json) but heap_capacity is 0. ` +
      `claimHeap() would compute heapWrite % 0 = NaN, silently aliasing all ` +
      `heap pointers to physOffset 0. Set heap_capacity > 0.`,
    );
  }

  return {
    schema_fingerprint: schemaFingerprint(schema),
    record_stride:      schema.record_stride,
    index_capacity,
    heap_capacity,
    total_bytes:        computeTotalBytes(index_capacity, schema.record_stride, heap_capacity),
    query,
    estimated_records,
    schema,
  };
}
