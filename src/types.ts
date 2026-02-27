/**
 * @strand/core — type definitions
 *
 * These types describe the Strand Memory Contract.
 * The Buffer IS the truth; TypeScript types are a lens into it.
 */

// ─── Field Types ──────────────────────────────────────────────────────────────

/**
 * Supported column types in a Strand schema.
 *
 * utf8:     Variable-length string stored in the heap region.
 *           Represented in the fixed-width record as:
 *             [heap_offset: u32][heap_len: u16]  (6 bytes total)
 *           heap_offset is a monotonic cursor; physical address =
 *             heapStart + (heap_offset % heap_capacity).
 *           The writer guarantees the string never spans the heap ring
 *           boundary — skip-sentinels force a wrap before any oversized write.
 *
 * utf8_ref: Interned string. The record stores a u32 handle into a
 *           side-channel intern table passed to StrandView. Use ONLY for
 *           low-cardinality strings whose values repeat frequently across
 *           records: chromosome names ('chr1'…'chrM'), filter tags ('PASS',
 *           'LowQual'), strand symbols ('+'/'-'). High-cardinality fields
 *           (read names, sequences, variant IDs) must use utf8 — the intern
 *           table grows monotonically with no eviction and becomes a memory
 *           leak if the value space is large. Rule of thumb: if the field has
 *           fewer than ~1000 distinct values per stream, utf8_ref is safe.
 *
 * json:     Variable-length JSON blob stored in the heap region, same wire
 *           format as utf8 ([heap_offset: u32][heap_len: u16], 6 bytes).
 *           Use for sparse per-record metadata whose shape is not known at
 *           schema definition time (INFO tags, FORMAT fields, annotation maps).
 *           The writer calls JSON.stringify() before writing; RecordCursor
 *           calls JSON.parse() on first access and caches the result.
 *           Prefer fixed-width fields for hot-path data — json decode is only
 *           lazy but still allocates a new object per record per seek().
 */
export type FieldType =
  | 'i32'
  | 'u32'
  | 'i64'
  | 'f32'
  | 'f64'
  | 'u16'
  | 'u8'
  | 'bool8'
  | 'utf8'
  | 'utf8_ref'
  | 'json'
  | 'bytes'
  | 'i32_array'
  | 'f32_array';

/** Byte width of each FieldType inside the fixed-width index record. */
export const FIELD_BYTE_WIDTHS: Readonly<Record<FieldType, number>> = {
  i32:       4,
  u32:       4,
  i64:       8,
  f32:       4,
  f64:       8,
  u16:       2,
  u8:        1,
  bool8:     1,
  utf8:      6, // [heap_offset: u32][heap_len: u16]
  utf8_ref:  4, // [intern_handle: u32]
  json:      6, // [heap_offset: u32][heap_len: u16] — same wire format as utf8
  bytes:     6, // [heap_offset: u32][heap_len: u16] — raw Uint8Array, 1-byte aligned
  i32_array: 6, // [heap_offset: u32][heap_len: u16] — Int32Array,   4-byte aligned
  f32_array: 6, // [heap_offset: u32][heap_len: u16] — Float32Array, 4-byte aligned
};

// ─── Field Flags ──────────────────────────────────────────────────────────────

export const FIELD_FLAG_NULLABLE    = 0b001;
export const FIELD_FLAG_SORTED_ASC  = 0b010;
export const FIELD_FLAG_SORTED_DESC = 0b100;

// ─── Schema ───────────────────────────────────────────────────────────────────

/**
 * One field in a Strand schema.
 *
 * byteOffset is the field's absolute start position within the fixed-width
 * index record. Assigned automatically by buildSchema(); stored explicitly in
 * the binary header so the decoder never has to re-derive alignment rules.
 */
export interface FieldDescriptor {
  readonly name:             string;
  readonly type:             FieldType;
  readonly byteOffset:       number;
  readonly flags:            number;
  /**
   * Ordinal position among nullable fields in schema declaration order.
   * Bit `nullableBitIndex % 8` of bitmap byte `Math.floor(nullableBitIndex / 8)`
   * in each record slot is 1 when this field was written, 0 when it was omitted.
   * Only present on fields with FIELD_FLAG_NULLABLE; undefined otherwise.
   */
  readonly nullableBitIndex?: number;
}

/**
 * Fully-resolved schema descriptor.
 *
 * record_stride is the byte length of one index record, padded to a 4-byte
 * boundary. This is the sole stride used for all ring-buffer slot arithmetic.
 */
export interface BinarySchemaDescriptor {
  readonly fields:        readonly FieldDescriptor[];
  readonly record_stride: number;
}

// ─── Strand Map ───────────────────────────────────────────────────────────────

/**
 * A serializable descriptor of a Strand SharedArrayBuffer.
 *
 * The server emits a StrandMap during SSR; it is embedded in the HTML response
 * as a JSON script tag. The client reads it synchronously during page init and
 * calls initStrandHeader() to pre-allocate the buffer before the first byte of
 * genomic data arrives over the wire.
 *
 * The Map is NOT the buffer. It describes the buffer's exact shape so that
 * independent allocations on the server and client produce identical layouts.
 * Only the geometry fields (fingerprint, stride, capacities) are stored in the
 * binary header. The query context is carried only in the JSON form.
 */
export interface StrandMap {
  /** FNV-1a 32-bit hash of the binary schema encoding. Validated on attach. */
  readonly schema_fingerprint: number;
  readonly record_stride:      number;

  /** Ring buffer capacity in records. Must be a power of 2. */
  readonly index_capacity: number;

  /** Heap region size in bytes. */
  readonly heap_capacity: number;

  /**
   * Exact SharedArrayBuffer byte length.
   * Equals HEADER_SIZE + index_capacity × record_stride + heap_capacity.
   */
  readonly total_bytes: number;

  /** The genomic query this buffer was sized for. */
  readonly query: {
    readonly assembly: string; // e.g. "hg38"
    readonly chrom:    string; // e.g. "chr1"
    readonly start:    number; // 0-based inclusive
    readonly end:      number; // 0-based exclusive
  };

  /** Server-side estimate from BAI/TBI index. Actual count may differ. */
  readonly estimated_records: number;

  readonly schema: BinarySchemaDescriptor;

  /**
   * Optional producer metadata stored in the header tail region (v5+).
   *
   * `initStrandHeader()` always writes a `columns: string[]` key to carry
   * field names through the header (binary schema bytes no longer contain
   * names in v5). If the caller also passes a plain `meta` object, it is
   * merged: `{ columns: [...], ...meta }`. The `columns` key is consumed
   * internally by `readStrandHeader()` to reconstruct named FieldDescriptors
   * and is then stripped — only caller-supplied keys appear here.
   *
   * Absent when the producer did not supply metadata beyond the auto-injected
   * columns, or when metadata was corrupt or unreadable.
   */
  readonly meta?: unknown;
}

// ─── Stream Status ────────────────────────────────────────────────────────────

export type StrandStatus = 'initializing' | 'streaming' | 'eos' | 'error';
