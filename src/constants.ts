/**
 * @strand/core — layout constants
 *
 * These constants define the binary contract of the Strand header.
 * Any change to byte offsets or magic values is a BREAKING CHANGE
 * requiring a version bump in STRAND_VERSION.
 *
 * The header occupies the first 512 bytes of every Strand SharedArrayBuffer:
 *
 *   ── Static section (DataView reads; written once, never modified) ────────
 *   [0..3]    magic           u32  = STRAND_MAGIC ('STRN')
 *   [4..7]    version         u32  = STRAND_VERSION
 *   [8..11]   schema_fp       u32  = FNV-1a of binary schema encoding
 *   [12..15]  record_stride   u32
 *   [16..19]  index_capacity  u32
 *   [20..23]  heap_capacity   u32
 *   [24..27]  header_crc      u32  = FNV-1a of bytes 0–23  ← v2 addition
 *
 *   ── Atomics section (Int32Array; mutable at runtime) ────────────────────
 *   [28..31]  CTRL_WRITE_SEQ   (Int32 index 7)
 *   [32..35]  CTRL_COMMIT_SEQ  (Int32 index 8)
 *   [36..39]  CTRL_READ_CURSOR (Int32 index 9)
 *   [40..43]  CTRL_STATUS      (Int32 index 10)
 *   [44..47]  CTRL_HEAP_WRITE  (Int32 index 11)
 *   [48..51]  CTRL_HEAP_COMMIT (Int32 index 12)
 *   [52..55]  CTRL_ABORT       (Int32 index 13)  ← v2 addition
 *
 *   ── Schema section (DataView reads) ────────────────────────────────────
 *   [56..59]  schema_byte_len  u32
 *   [60..511] binary schema descriptor (up to 452 bytes)
 */

// ─── Magic & Version ──────────────────────────────────────────────────────────

/** 'STRN' as a little-endian u32. Checked as the first validation on any SAB. */
export const STRAND_MAGIC:   number = 0x5354524e;

/**
 * Header format version.
 * v1 → v2: added OFFSET_HEADER_CRC at byte 24; shifted Atomics words and
 *           schema section by 8 bytes; added CTRL_ABORT.
 */
export const STRAND_VERSION: number = 2;

// ─── Header Layout ────────────────────────────────────────────────────────────

export const HEADER_SIZE = 512; // bytes

/**
 * Byte offsets for static header fields. Read via DataView only.
 * These are written once by initStrandHeader and never modified.
 */
export const OFFSET_MAGIC           =  0; // u32
export const OFFSET_VERSION         =  4; // u32
export const OFFSET_SCHEMA_FP       =  8; // u32 — FNV-1a of binary schema descriptor
export const OFFSET_RECORD_STRIDE   = 12; // u32
export const OFFSET_INDEX_CAPACITY  = 16; // u32 — must be a power of 2
export const OFFSET_HEAP_CAPACITY   = 20; // u32

/**
 * FNV-1a checksum of the six static geometry fields at bytes 0–23.
 * Written by initStrandHeader after all static fields are set.
 * Validated by readStrandHeader before any geometry values are used.
 * Detects rogue-pointer corruption of index_capacity, record_stride, etc.
 */
export const OFFSET_HEADER_CRC      = 24; // u32

// Bytes 28–55: Atomics control words (Int32Array view, NOT DataView).

export const OFFSET_SCHEMA_BYTE_LEN = 56; // u32
export const OFFSET_SCHEMA_BYTES    = 60; // variable, up to MAX_SCHEMA_BYTES

/** Maximum schema descriptor bytes that fit inside the 512-byte header. */
export const MAX_SCHEMA_BYTES = HEADER_SIZE - OFFSET_SCHEMA_BYTES; // 452

// ─── Atomics Control Word Indices ─────────────────────────────────────────────

/**
 * Int32Array indices for the seven Atomics control words.
 *
 * ctrl32[i] maps to SAB byte offset (i × 4).
 * These are the ONLY legal targets for Atomics operations.
 * All other header fields use plain DataView reads.
 *
 * Producers write to WRITE_SEQ, HEAP_WRITE, HEAP_COMMIT, STATUS.
 * Producers read READ_CURSOR for backpressure and CTRL_ABORT for termination.
 * Producers advance COMMIT_SEQ last — this is the visibility fence.
 *
 * Consumers read COMMIT_SEQ (via Atomics.load or Atomics.waitAsync).
 * Consumers advance READ_CURSOR to unblock a stalled producer.
 * Consumers write CTRL_ABORT = 1 to signal the producer to stop.
 */
export const CTRL_WRITE_SEQ   = 7;  // byte 28 — producer: next seq to claim (monotonic)
export const CTRL_COMMIT_SEQ  = 8;  // byte 32 — producer: highest committed seq
export const CTRL_READ_CURSOR = 9;  // byte 36 — consumer: acknowledged read position
export const CTRL_STATUS      = 10; // byte 40 — stream lifecycle (see STATUS_* below)
export const CTRL_HEAP_WRITE  = 11; // byte 44 — producer: heap write cursor (monotonic bytes)
export const CTRL_HEAP_COMMIT = 12; // byte 48 — producer: heap committed bytes
export const CTRL_ABORT       = 13; // byte 52 — consumer: set to 1 to signal producer abort

/** Int32Array length that covers the entire 512-byte header. */
export const CTRL_ARRAY_LEN = HEADER_SIZE / 4; // 128

// ─── Status Values ────────────────────────────────────────────────────────────

export const STATUS_INITIALIZING = 0; // producer constructed, not yet writing — do not interpret seq=0 as empty
export const STATUS_STREAMING    = 1; // begin() called, records flowing
export const STATUS_EOS          = 2; // finalize() called — no more records will be written
export const STATUS_ERROR        = 3; // abort() called — stream failed; heap may be partial

// ─── Heap Skip Sentinel ───────────────────────────────────────────────────────

/**
 * Written at the heap write cursor when a record's variable-length data
 * would extend past the physical end of the heap region.
 *
 * Wire layout (6 bytes):
 *   [HEAP_SKIP_MAGIC: u16 = 0xFFFF]
 *   [bytes_to_skip:   u32]          — distance to advance to reach wrap-around origin
 *
 * Consumers encountering 0xFFFF as the first u16 of a heap block advance
 * their read cursor by bytes_to_skip and re-read from the heap origin.
 *
 * Valid UTF-8 sequence strings never start with 0xFF, making this safe as a
 * sentinel. (0xFF is not a valid UTF-8 leading byte.)
 */
export const HEAP_SKIP_MAGIC = 0xffff; // u16
export const HEAP_SKIP_SIZE  = 6;      // 2 (magic) + 4 (skip_bytes)

// ─── Geometry Helpers ─────────────────────────────────────────────────────────

/** Byte offset at which the index region begins. Always equals HEADER_SIZE. */
export const INDEX_START = HEADER_SIZE;

/** Byte offset at which the heap region begins. */
export function heapStart(indexCapacity: number, recordStride: number): number {
  return HEADER_SIZE + indexCapacity * recordStride;
}

/**
 * Total SharedArrayBuffer size for a given layout.
 * Used on the server to compute StrandMap.total_bytes.
 */
export function computeTotalBytes(
  indexCapacity: number,
  recordStride:  number,
  heapCapacity:  number,
): number {
  return HEADER_SIZE + indexCapacity * recordStride + heapCapacity;
}
