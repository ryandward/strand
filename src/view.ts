/**
 * @strand/core — StrandView
 *
 * Read-only lens into a SharedArrayBuffer initialized by @strand/core.
 *
 * StrandView is the consumer-facing API. It:
 *   1. Validates the header on construction (magic → version → fingerprint).
 *   2. Exposes committedCount and status via Atomics.load — no blocking.
 *   3. Provides waitForCommit() via Atomics.waitAsync — legal on the main
 *      thread (unlike Atomics.wait, which is Worker-only).
 *   4. Exposes acknowledgeRead() to advance the consumer cursor, unblocking
 *      a producer stalled on a full ring.
 *
 * RecordCursor gives schema-driven field access for committed records via a
 * seek-in-place API. Allocate once with StrandView.allocateCursor(), then
 * call cursor.seek(seq) for each record — zero heap allocations per record.
 *
 * Consumer pattern (main thread):
 *
 *   const view   = new StrandView(sab, chromosomeNames);
 *   const cursor = view.allocateCursor();
 *   let   seq    = 0;
 *
 *   async function drain() {
 *     while (true) {
 *       const count = await view.waitForCommit(seq);
 *       for (; seq < count; seq++) {
 *         cursor.seek(seq);
 *         const pos  = cursor.getI64('pos');          // bigint
 *         const seqStr = cursor.getString('sequence'); // decoded from heap
 *         render(pos, seqStr);
 *       }
 *       view.acknowledgeRead(count);
 *       if (view.status === 'eos') break;
 *     }
 *   }
 *   drain();
 */

import {
  INDEX_START,
  CTRL_ARRAY_LEN,
  CTRL_COMMIT_SEQ,
  CTRL_READ_CURSOR,
  CTRL_STATUS,
  CTRL_ABORT,
  CTRL_CONSUMER_BASE,
  MAX_CONSUMERS,
  CONSUMER_SLOT_VACANT,
  STATUS_INITIALIZING,
  STATUS_STREAMING,
  STATUS_EOS,
  STATUS_ERROR,
  heapStart,
} from './constants';
import { readStrandHeader } from './header';
import {
  FIELD_BYTE_WIDTHS,
  FIELD_FLAG_NULLABLE,
  FIELD_FLAG_SORTED_ASC,
  type FieldDescriptor,
  type FieldType,
  type StrandMap,
  type StrandStatus,
} from './types';
import { createBitset, forEachSet, type ConstrainedRanges, type FilterPredicate } from './bitset';

// ─── Module-level shared decoder ──────────────────────────────────────────────

// TextDecoder is stateless (when not used in streaming mode), so one instance
// is safe to reuse across all getString() calls across all RecordCursor instances.
const utf8Decoder = new TextDecoder();

// Field types on which findFirst() can perform a binary comparison.
// utf8 / utf8_ref / json / bool8 are excluded: their binary representations
// are either heap pointers (not the value itself) or require string collation.
const SORTABLE_TYPES = new Set<FieldType>([
  'i32', 'u32', 'i64', 'f32', 'f64', 'u16', 'u8',
]);

// ─── RecordCursor ─────────────────────────────────────────────────────────────

/**
 * A zero-copy, seek-in-place cursor into the Strand index region.
 *
 * Allocate once with StrandView.allocateCursor(), then call seek(seq) for
 * each record you want to read. All field reads reference the SharedArrayBuffer
 * directly — nothing is deserialized until you call a typed accessor.
 *
 * getString() maintains a per-record decode cache: calling it twice on the
 * same field for the same seq returns the cached result with zero additional
 * allocations. The cache is cleared automatically on each seek() to a new seq.
 *
 * Do not use a cursor for records whose ring slots may have been reused;
 * seek() throws RangeError if the producer has lapped the consumer.
 */
export class RecordCursor {
  /** Absolute, monotonic sequence number of the current record. -1 before first seek. */
  seq: number = -1;

  private _recordOffset: number = 0;
  private readonly _stringCache = new Map<string, string>();
  private readonly _jsonCache   = new Map<string, unknown>();

  /** @internal — use StrandView.allocateCursor() */
  constructor(
    private readonly _ctrl:           Int32Array,
    private readonly _data:           DataView,
    private readonly _sab:            SharedArrayBuffer,
    private readonly _fieldIndex:     ReadonlyMap<string, FieldDescriptor>,
    private readonly _heapStartByte:  number,
    private readonly _heapCapacity:   number,
    private readonly _internTableCell: { value: readonly string[] },
    private readonly _indexCapacity:  number,
    private readonly _recordStride:   number,
  ) {}

  /**
   * Seek to the record at absolute sequence number `seq`.
   *
   * Returns false when:
   *   seq < 0  or  seq >= committedCount
   *
   * Throws RangeError when:
   *   The record has been overwritten because the consumer fell more than
   *   index_capacity records behind the producer. This is a programming error:
   *   call acknowledgeRead() frequently enough to keep the ring from wrapping
   *   around onto unread records.
   *
   * Zero heap allocations on every call. The string cache is cleared when
   * seeking to a different seq; seeking to the same seq is idempotent.
   */
  seek(seq: number): boolean {
    if (seq < 0) return false;

    const committed = Atomics.load(this._ctrl, CTRL_COMMIT_SEQ);
    if (seq >= committed) return false;

    const oldestAvailable = Math.max(0, committed - this._indexCapacity);
    if (seq < oldestAvailable) {
      throw new RangeError(
        `Record ${seq} has been overwritten by the producer. ` +
        `Oldest available seq: ${oldestAvailable}. ` +
        `Call acknowledgeRead() more frequently to prevent ring-buffer lap.`,
      );
    }

    if (seq !== this.seq) {
      this._stringCache.clear();
      this._jsonCache.clear();
      this.seq = seq;
    }

    // Fast modulo for power-of-2 ring capacity.
    this._recordOffset = INDEX_START + (seq & (this._indexCapacity - 1)) * this._recordStride;
    return true;
  }

  // ── Null bitmap check ──────────────────────────────────────────────────────

  /**
   * Returns true when `f` is a nullable field that was omitted from the
   * record at the current seek position. The null validity bitmap lives at
   * the very start of each record slot (bytes 0..bitmapBytes-1).
   *
   * Bit `f.nullableBitIndex % 8` of byte `Math.floor(f.nullableBitIndex / 8)`
   * is 1 when the field was written, 0 when it was omitted (null).
   */
  private _isNull(f: FieldDescriptor): boolean {
    if (!(f.flags & FIELD_FLAG_NULLABLE) || f.nullableBitIndex === undefined) return false;
    const byteIndex  = Math.floor(f.nullableBitIndex / 8);
    const bit        = 1 << (f.nullableBitIndex % 8);
    const bitmapByte = this._data.getUint8(this._recordOffset + byteIndex);
    return !(bitmapByte & bit);
  }

  // ── Typed accessors ────────────────────────────────────────────────────────
  // Each returns null if the field does not exist, has the wrong type, or
  // (for nullable fields) was omitted from the record at the current seq.

  getI32(name: string): number | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'i32') return null;
    if (this._isNull(f)) return null;
    return this._data.getInt32(this._recordOffset + f.byteOffset, /* le */ true);
  }

  getU32(name: string): number | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'u32') return null;
    if (this._isNull(f)) return null;
    return this._data.getUint32(this._recordOffset + f.byteOffset, true);
  }

  getI64(name: string): bigint | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'i64') return null;
    if (this._isNull(f)) return null;
    return this._data.getBigInt64(this._recordOffset + f.byteOffset, true);
  }

  getF32(name: string): number | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'f32') return null;
    if (this._isNull(f)) return null;
    return this._data.getFloat32(this._recordOffset + f.byteOffset, true);
  }

  getF64(name: string): number | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'f64') return null;
    if (this._isNull(f)) return null;
    return this._data.getFloat64(this._recordOffset + f.byteOffset, true);
  }

  getU16(name: string): number | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'u16') return null;
    if (this._isNull(f)) return null;
    return this._data.getUint16(this._recordOffset + f.byteOffset, true);
  }

  getU8(name: string): number | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'u8') return null;
    if (this._isNull(f)) return null;
    return this._data.getUint8(this._recordOffset + f.byteOffset);
  }

  getBool(name: string): boolean | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'bool8') return null;
    if (this._isNull(f)) return null;
    return this._data.getUint8(this._recordOffset + f.byteOffset) !== 0;
  }

  /**
   * Decode a variable-length UTF-8 string from the heap.
   *
   * The record stores [heap_offset: u32][heap_len: u16] at f.byteOffset.
   * heap_offset is a monotonic counter; physical position in the SAB is:
   *   heapStartByte + (heap_offset % heapCapacity)
   *
   * The writer guarantees no string spans the heap ring boundary
   * (skip-sentinels force a wrap before any too-large write), so the
   * subarray is always physically contiguous.
   *
   * The decoded result is cached by field name for the current record.
   * Subsequent calls with the same name on the same seq return the cached
   * string with zero additional allocations.
   */
  getString(name: string): string | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'utf8') return null;
    if (this._isNull(f)) return null;

    const cached = this._stringCache.get(name);
    if (cached !== undefined) return cached;

    const heapOffset = this._data.getUint32(this._recordOffset + f.byteOffset,     true);
    const heapLen    = this._data.getUint16(this._recordOffset + f.byteOffset + 4, true);

    if (heapLen === 0) {
      this._stringCache.set(name, '');
      return '';
    }

    const physOffset = this._heapStartByte + (heapOffset % this._heapCapacity);

    if (physOffset + heapLen > this._sab.byteLength) {
      throw new RangeError(
        `Heap read out of bounds for field '${name}': ` +
        `physOffset=${physOffset} len=${heapLen} bufLen=${this._sab.byteLength}. ` +
        `This indicates a writer/consumer ring-wrap mismatch.`,
      );
    }

    // .slice() copies the heap bytes into a plain ArrayBuffer before decoding.
    // TextDecoder.decode() rejects SAB-backed views in all browsers (spec
    // requirement); Node.js allows it, so tests pass without this, masking
    // the bug. The per-record _stringCache means each field is only copied
    // once per seek(), so the overhead is negligible on the hot read path.
    const bytes = new Uint8Array(this._sab, physOffset, heapLen).slice();
    const decoded = utf8Decoder.decode(bytes);
    this._stringCache.set(name, decoded);
    return decoded;
  }

  /**
   * Decode and parse a json field from the heap.
   *
   * The heap bytes are a UTF-8 encoded JSON string written by the producer via
   * JSON.stringify(). This method decodes the bytes and calls JSON.parse() on
   * first access, then caches the parsed result for the current record. A second
   * call for the same field and same seq returns the cached object — no
   * re-decode, no re-parse.
   *
   * Returns null if the field does not exist, has the wrong type, or was
   * written with a null / non-serializable value.
   */
  getJson(name: string): unknown {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'json') return null;
    if (this._isNull(f)) return null;

    const cached = this._jsonCache.get(name);
    if (cached !== undefined) return cached;

    const heapOffset = this._data.getUint32(this._recordOffset + f.byteOffset,     true);
    const heapLen    = this._data.getUint16(this._recordOffset + f.byteOffset + 4, true);

    if (heapLen === 0) {
      this._jsonCache.set(name, null);
      return null;
    }

    const physOffset = this._heapStartByte + (heapOffset % this._heapCapacity);

    if (physOffset + heapLen > this._sab.byteLength) {
      throw new RangeError(
        `Heap read out of bounds for field '${name}': ` +
        `physOffset=${physOffset} len=${heapLen} bufLen=${this._sab.byteLength}. ` +
        `This indicates a writer/consumer ring-wrap mismatch.`,
      );
    }

    // .slice() — same reason as getString(): TextDecoder rejects SAB-backed views in browsers.
    const bytes   = new Uint8Array(this._sab, physOffset, heapLen).slice();
    const text    = utf8Decoder.decode(bytes);
    const parsed: unknown = JSON.parse(text);
    this._jsonCache.set(name, parsed);
    return parsed;
  }

  /**
   * Return a zero-copy Uint8Array view into the SAB heap for a bytes field.
   *
   * The view is valid as long as the producer has not lapped the heap ring
   * and overwritten this region. Copy the data if you need it to outlive
   * the current record window.
   *
   * Returns null for an empty or missing field.
   */
  getBytes(name: string): Uint8Array | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'bytes') return null;
    if (this._isNull(f)) return null;

    const heapOffset = this._data.getUint32(this._recordOffset + f.byteOffset,     true);
    const heapLen    = this._data.getUint16(this._recordOffset + f.byteOffset + 4, true);
    if (heapLen === 0) return null;

    const physOffset = this._heapStartByte + (heapOffset % this._heapCapacity);
    return new Uint8Array(this._sab, physOffset, heapLen);
  }

  /**
   * Return a zero-copy Int32Array view into the SAB heap for an i32_array field.
   *
   * The writer guarantees the heap offset is 4-byte aligned (via claimHeap
   * alignment padding), so the Int32Array constructor never throws. Returns
   * null for an empty or missing field.
   */
  getI32Array(name: string): Int32Array | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'i32_array') return null;
    if (this._isNull(f)) return null;

    const heapOffset = this._data.getUint32(this._recordOffset + f.byteOffset,     true);
    const heapLen    = this._data.getUint16(this._recordOffset + f.byteOffset + 4, true);
    if (heapLen === 0) return null;

    const physOffset = this._heapStartByte + (heapOffset % this._heapCapacity);
    return new Int32Array(this._sab, physOffset, heapLen / 4);
  }

  /**
   * Return a zero-copy Float32Array view into the SAB heap for an f32_array field.
   *
   * The writer guarantees the heap offset is 4-byte aligned (via claimHeap
   * alignment padding), so the Float32Array constructor never throws. Returns
   * null for an empty or missing field.
   */
  getF32Array(name: string): Float32Array | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'f32_array') return null;
    if (this._isNull(f)) return null;

    const heapOffset = this._data.getUint32(this._recordOffset + f.byteOffset,     true);
    const heapLen    = this._data.getUint16(this._recordOffset + f.byteOffset + 4, true);
    if (heapLen === 0) return null;

    const physOffset = this._heapStartByte + (heapOffset % this._heapCapacity);
    return new Float32Array(this._sab, physOffset, heapLen / 4);
  }

  /**
   * Resolve a utf8_ref field to its interned string.
   *
   * utf8_ref fields store a u32 handle. The intern table is a string array
   * passed to StrandView on construction. Index 0 = handle 0, etc.
   * Typically used for chromosome names (low cardinality, frequently repeated).
   *
   * Returns null if no intern table was provided or the handle is out of range.
   */
  getRef(name: string): string | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'utf8_ref') return null;
    if (this._isNull(f)) return null;

    const handle = this._data.getUint32(this._recordOffset + f.byteOffset, true);
    return this._internTableCell.value[handle] ?? null;
  }

  /**
   * Generic accessor. Returns the most appropriate JS type for the field:
   *   numeric types → number
   *   i64           → bigint
   *   bool8         → boolean
   *   utf8          → string (decoded from heap on read, cached per record)
   *   utf8_ref      → string (resolved from intern table on read)
   *   json          → unknown (parsed from heap on read, cached per record)
   *   unknown field → null
   *
   * For json fields, prefer calling getJson() directly to preserve the
   * `unknown` return type without downcasting.
   */
  get(name: string): number | bigint | boolean | string | unknown {
    const f = this._fieldIndex.get(name);
    if (!f) return null;

    switch (f.type) {
      case 'i32':      return this.getI32(name);
      case 'u32':      return this.getU32(name);
      case 'i64':      return this.getI64(name);
      case 'f32':      return this.getF32(name);
      case 'f64':      return this.getF64(name);
      case 'u16':      return this.getU16(name);
      case 'u8':       return this.getU8(name);
      case 'bool8':    return this.getBool(name);
      case 'utf8':      return this.getString(name);
      case 'utf8_ref':  return this.getRef(name);
      case 'json':      return this.getJson(name);
      case 'bytes':     return this.getBytes(name);
      case 'i32_array': return this.getI32Array(name);
      case 'f32_array': return this.getF32Array(name);
    }
  }
}

// ─── StrandView ───────────────────────────────────────────────────────────────

/**
 * Read-only lens into a Strand SharedArrayBuffer.
 *
 * Construction validates the full header chain:
 *   magic → version → schema decode → fingerprint
 * Any failure throws StrandHeaderError before the object is usable.
 *
 * @param sab         A SharedArrayBuffer initialized with initStrandHeader().
 * @param internTable Optional. String array for resolving utf8_ref field handles.
 *                    Index N resolves handle N. Typically the chromosome name
 *                    list: ['chr1', 'chr2', ..., 'chrX', 'chrY', 'chrM'].
 *                    Must contain fewer than ~1000 distinct values — the intern
 *                    table grows monotonically with no eviction. Use utf8 for
 *                    high-cardinality fields (read names, sequences, variant IDs).
 */
export class StrandView {
  /** The underlying SAB. Pass to Workers via postMessage — zero-copy. */
  readonly sab: SharedArrayBuffer;

  /** StrandMap reconstructed from the binary header. */
  readonly map: StrandMap;

  private readonly ctrl:           Int32Array;
  private readonly data:           DataView;
  private readonly fieldIndex:     ReadonlyMap<string, FieldDescriptor>;
  private readonly heapStartByte:  number;

  /**
   * Indirection cell so updateInternTable() propagates to all allocated cursors
   * without needing to track them. Both StrandView and every RecordCursor hold
   * a reference to this same object; mutating `.value` is immediately visible
   * to all cursors.
   */
  private readonly _internTableCell: { value: readonly string[] };

  constructor(sab: SharedArrayBuffer, internTable: readonly string[] = []) {
    // readStrandHeader throws on any validation failure.
    // No partial state is possible: either the view is fully valid or it throws.
    this.map               = readStrandHeader(sab);
    this.sab               = sab;
    this.ctrl              = new Int32Array(sab, 0, CTRL_ARRAY_LEN);
    this.data              = new DataView(sab);
    this._internTableCell  = { value: internTable };
    this.heapStartByte     = heapStart(this.map.index_capacity, this.map.record_stride);
    this.fieldIndex        = new Map(this.map.schema.fields.map(f => [f.name, f]));
  }

  /**
   * Replace the intern table used to resolve utf8_ref field handles.
   *
   * Safe to call at any batch boundary — no locking required. All cursors
   * allocated from this view share the same indirection cell, so they all
   * observe the new table immediately after this call returns.
   *
   * Typical use: the server streams chromosome names as a pre-amble message
   * before the first record batch, then the client calls updateInternTable()
   * once per query region or assembly change.
   *
   * @param table  New intern table. Index N resolves utf8_ref handle N.
   */
  updateInternTable(table: readonly string[]): void {
    this._internTableCell.value = table;
  }

  // ── Atomic state queries ───────────────────────────────────────────────────

  /**
   * Number of records committed by the producer and safe to read.
   * Uses Atomics.load — sequentially consistent, never observes a stale value.
   */
  get committedCount(): number {
    return Atomics.load(this.ctrl, CTRL_COMMIT_SEQ);
  }

  /** Current stream lifecycle status. */
  get status(): StrandStatus {
    const raw = Atomics.load(this.ctrl, CTRL_STATUS);
    switch (raw) {
      case STATUS_STREAMING:    return 'streaming';
      case STATUS_EOS:          return 'eos';
      case STATUS_ERROR:        return 'error';
      case STATUS_INITIALIZING:
      default:                  return 'initializing';
    }
  }

  // ── Cursor allocation ──────────────────────────────────────────────────────

  /**
   * Allocate a RecordCursor that shares this view's immutable state.
   *
   * Call once before a scan loop; reuse the cursor across all seek() calls.
   * Each cursor is independent — allocate one per concurrent scan thread.
   *
   * @returns A new RecordCursor with seq === -1. Call cursor.seek(seq) to
   *          position it on a committed record before reading fields.
   */
  allocateCursor(): RecordCursor {
    return new RecordCursor(
      this.ctrl,
      this.data,
      this.sab,
      this.fieldIndex,
      this.heapStartByte,
      this.map.heap_capacity,
      this._internTableCell,
      this.map.index_capacity,
      this.map.record_stride,
    );
  }

  // ── Sorted seek ────────────────────────────────────────────────────────────

  /**
   * Binary-search the committed ring for the first record where `field >= value`.
   *
   * Requirements:
   *   - The field must be declared with FIELD_FLAG_SORTED_ASC in the schema.
   *     Records must actually arrive in non-decreasing order; this method
   *     does not verify the invariant at runtime.
   *   - The field must be a numeric type: i32, u32, i64, f32, f64, u16, u8.
   *     utf8, utf8_ref, json, and bool8 are not supported.
   *
   * Returns the lowest seq number in the committed window where the field
   * value is >= `value`, or -1 if no such record exists in the current
   * committed window.
   *
   * -1 has two distinct causes:
   *   a) All committed records have field < value (target is ahead of stream).
   *      Re-arm waitForCommit() and retry.
   *   b) The target was in a ring slot that has been lapped. The caller must
   *      restart the stream or seek from the oldest available record.
   *
   * For i64 fields, `value` may be either a bigint or a number (auto-coerced).
   * For all other types, passing a bigint coerces to Number.
   *
   * O(log index_capacity).
   */
  findFirst(field: string, value: number | bigint): number {
    const f = this.fieldIndex.get(field);
    if (!f) {
      throw new TypeError(
        `findFirst: unknown field '${field}'. ` +
        `Available fields: ${[...this.fieldIndex.keys()].join(', ')}.`,
      );
    }

    if (!(f.flags & FIELD_FLAG_SORTED_ASC)) {
      throw new TypeError(
        `findFirst: field '${field}' does not have FIELD_FLAG_SORTED_ASC. ` +
        `Only fields declared with FIELD_FLAG_SORTED_ASC support binary seek. ` +
        `For unsorted fields, scan with a cursor instead.`,
      );
    }

    if (!SORTABLE_TYPES.has(f.type)) {
      throw new TypeError(
        `findFirst: field '${field}' has type '${f.type}', which is not a ` +
        `sortable numeric type. Sortable types: ${[...SORTABLE_TYPES].join(', ')}. ` +
        `utf8, utf8_ref, json, and bool8 store indirect or non-ordinal values.`,
      );
    }

    const committed = Atomics.load(this.ctrl, CTRL_COMMIT_SEQ);
    if (committed === 0) return -1;

    const oldest = Math.max(0, committed - this.map.index_capacity);

    // Coerce the target value to the field's native comparison type once,
    // outside the hot loop.
    const isI64   = f.type === 'i64';
    const target: number | bigint = isI64
      ? (typeof value === 'bigint' ? value : BigInt(Math.trunc(value as number)))
      : (typeof value === 'number' ? value : Number(value as bigint));

    // Standard lower_bound: find the leftmost seq where fieldValue >= target.
    // Invariant: all seq in [oldest, lo)  have fieldValue < target.
    //            all seq in [hi, committed) have fieldValue >= target (or hi===committed).
    let lo = oldest;
    let hi = committed;

    while (lo < hi) {
      // Safe midpoint: avoids integer overflow for very large seq numbers.
      const mid = lo + Math.floor((hi - lo) / 2);
      const v   = this.readNumericAt(mid, f);

      const less = isI64
        ? (v as bigint)  < (target as bigint)
        : (v as number)  < (target as number);

      if (less) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    // lo is now the first seq where field >= target.
    // If lo === committed, no record in the current window satisfies it.
    return lo < committed ? lo : -1;
  }

  /**
   * Read the raw numeric value of `field` at ring seq `seq`.
   * No bounds check, no cache — used only by findFirst's binary search loop.
   */
  private readNumericAt(seq: number, f: FieldDescriptor): number | bigint {
    const base =
      INDEX_START +
      (seq & (this.map.index_capacity - 1)) * this.map.record_stride +
      f.byteOffset;

    switch (f.type) {
      case 'u32': return this.data.getUint32(base,    true);
      case 'i32': return this.data.getInt32(base,     true);
      case 'i64': return this.data.getBigInt64(base,  true);
      case 'f32': return this.data.getFloat32(base,   true);
      case 'f64': return this.data.getFloat64(base,   true);
      case 'u16': return this.data.getUint16(base,    true);
      case 'u8':  return this.data.getUint8(base);
      default:
        // Unreachable: SORTABLE_TYPES guard in findFirst() prevents this.
        throw new TypeError(
          `readNumericAt: field '${f.name}' (type '${f.type}') is not numeric.`,
        );
    }
  }

  // ── Async notification ─────────────────────────────────────────────────────

  /**
   * Wait for at least one new committed record beyond `after`.
   *
   * Uses Atomics.waitAsync — legal on the main thread (Atomics.wait is not).
   * Resolves immediately if committedCount > after at call time.
   * On timeout, resolves with the current committedCount (may still equal `after`).
   *
   * @param after     Last-seen committed count. Waits until committedCount > after.
   * @param timeoutMs Maximum ms to wait. Defaults to no timeout (Infinity).
   * @returns         The new committedCount.
   */
  async waitForCommit(after: number, timeoutMs?: number): Promise<number> {
    // Fast path: data is already available.
    const current = Atomics.load(this.ctrl, CTRL_COMMIT_SEQ);
    if (current > after) return current;

    const result = Atomics.waitAsync(
      this.ctrl,
      CTRL_COMMIT_SEQ,
      after,
      timeoutMs ?? Infinity,
    );

    if (!result.async) {
      // 'not-equal': the value changed between our Atomics.load and waitAsync.
      return Atomics.load(this.ctrl, CTRL_COMMIT_SEQ);
    }

    await result.value; // Promise resolves with 'ok' | 'timed-out'
    return Atomics.load(this.ctrl, CTRL_COMMIT_SEQ);
  }

  // ── Consumer acknowledgment ────────────────────────────────────────────────

  /**
   * Advance the consumer read cursor to `upTo`.
   *
   * Without `token` (single-consumer mode): advances the global CTRL_READ_CURSOR,
   * exactly as in v2. This is the default for callers that have not called
   * registerConsumer().
   *
   * With `token` (multi-consumer mode): advances only the per-consumer cursor
   * for that token. The producer gates on effectiveReadCursor (the minimum
   * across all registered consumers and the global cursor).
   *
   * Always fires Atomics.notify on CTRL_READ_CURSOR to wake a stalled producer
   * regardless of which cursor was advanced.
   *
   * **REQUIRED in the drain loop — even for filtered records.**
   *
   * Call this unconditionally for every record consumed, regardless of whether
   * the record passed a filter or was skipped. The ring only advances when the
   * read cursor advances. If you omit this call, or call it only for records
   * that pass a filter, the producer will stall once the ring fills (when
   * total committed records exceed `index_capacity`) and the consumer will
   * deadlock waiting for more commits.
   *
   * Correct pattern:
   * ```
   * for (; seq < count; seq++) {
   *   cursor.seek(seq);
   *   if (cursor.getF32('score')! > threshold) render(cursor); // optional filter
   * }
   * view.acknowledgeRead(count); // ← outside the loop, acknowledges ALL records
   * ```
   *
   * Only call this after you are done reading all records up to (not including)
   * `upTo`. Do not call with a value higher than committedCount.
   */
  acknowledgeRead(upTo: number, token?: number): void {
    const committed = Atomics.load(this.ctrl, CTRL_COMMIT_SEQ);
    if (upTo > committed) {
      throw new RangeError(
        `acknowledgeRead(${upTo}) exceeds committedCount (${committed}). ` +
        `Only acknowledge records that have already been committed.`,
      );
    }
    if (token !== undefined) {
      Atomics.store(this.ctrl, CTRL_CONSUMER_BASE + token, upTo);
    } else {
      Atomics.store(this.ctrl, CTRL_READ_CURSOR, upTo);
    }
    // Always notify on CTRL_READ_CURSOR — the producer always waits there.
    Atomics.notify(this.ctrl, CTRL_READ_CURSOR, 1);
  }

  // ── Multi-consumer registration ────────────────────────────────────────────

  /**
   * Register this caller as a named consumer and return a token.
   *
   * Claims the first vacant consumer cursor slot via CAS. The returned token
   * is an integer in [0, MAX_CONSUMERS). Pass it to acknowledgeRead() and
   * releaseConsumer() to identify this consumer.
   *
   * The producer's ring-space gate becomes the minimum of:
   *   - The global CTRL_READ_CURSOR (advanced by tokenless acknowledgeRead)
   *   - All registered consumer cursors (advanced by token acknowledgeRead)
   *
   * Throws RangeError if all MAX_CONSUMERS slots are already occupied.
   */
  registerConsumer(): number {
    for (let i = 0; i < MAX_CONSUMERS; i++) {
      const prev = Atomics.compareExchange(
        this.ctrl, CTRL_CONSUMER_BASE + i, CONSUMER_SLOT_VACANT, 0,
      );
      if (prev === CONSUMER_SLOT_VACANT) return i;
    }
    throw new RangeError(
      `All ${MAX_CONSUMERS} consumer slots are occupied. ` +
      `Call releaseConsumer() when a consumer is done to free its slot.`,
    );
  }

  /**
   * Release a consumer slot, removing it from backpressure accounting.
   *
   * After this call the token is invalid. A stalled producer is woken
   * immediately so it can recompute effectiveReadCursor without the
   * released slot.
   */
  releaseConsumer(token: number): void {
    Atomics.store(this.ctrl, CTRL_CONSUMER_BASE + token, CONSUMER_SLOT_VACANT);
    Atomics.notify(this.ctrl, CTRL_READ_CURSOR, 1);
  }

  /**
   * The minimum acknowledged position across all cursors.
   *
   * This is the value the producer uses to determine how many ring slots it
   * may reclaim. It is the minimum of:
   *   - CTRL_READ_CURSOR  (global / single-consumer cursor)
   *   - All registered consumer cursors (non-VACANT slots)
   *
   * With no consumers registered, equals CTRL_READ_CURSOR.
   */
  get effectiveReadCursor(): number {
    // When any consumer is registered (multi-consumer mode), the effective gate
    // is the minimum of all registered consumer positions. The global
    // CTRL_READ_CURSOR is not included — it applies only in single-consumer mode.
    //
    // When no consumers are registered (single-consumer / legacy mode), the
    // global CTRL_READ_CURSOR is the sole gate (unchanged v2 behaviour).
    let min = -1; // sentinel: no registered consumer seen yet
    for (let i = 0; i < MAX_CONSUMERS; i++) {
      const v = Atomics.load(this.ctrl, CTRL_CONSUMER_BASE + i);
      if (v !== CONSUMER_SLOT_VACANT) {
        min = min < 0 ? v : Math.min(min, v);
      }
    }
    return min >= 0 ? min : Atomics.load(this.ctrl, CTRL_READ_CURSOR);
  }

  // ── Vectorized bitset scan ─────────────────────────────────────────────────

  /**
   * Inclusive start of the accessible ring window.
   *
   * Records older than this seq have been overwritten. Use this to convert
   * forEachSet bit indices back to absolute seq numbers:
   *   forEachSet(bs, view.committedCount - view.windowStart, j => {
   *     const seq = view.windowStart + j;
   *   });
   */
  get windowStart(): number {
    return Math.max(0, this.committedCount - this.map.index_capacity);
  }

  /**
   * Scan every committed record in the active ring window and return a bitset
   * where bit j is set when the record at seq `windowStart + j` satisfies
   * `predicate` for `field`.
   *
   * Supported field types: i32, u32, f32, f64, u16, u8, bool8, utf8_ref.
   * Heap-indirected types (utf8, json, bytes, i32_array, f32_array) and i64
   * are not supported — they throw TypeError.
   *
   * Architectural constraints:
   *
   *   Windowed reality  — scans only [windowStart, committedCount).
   *   Logical indexing  — bit j corresponds to seq = windowStart + j. Bitsets
   *                       built from the same committedCount snapshot are
   *                       directly comparable via computeIntersection.
   *   Hot-loop purity   — no RecordCursor, no JS object per record. Field
   *                       byte-offsets and the DataView reader are resolved
   *                       once outside the loop; the loop body is a single
   *                       DataView read + predicate test + conditional bit set.
   *
   * @param field     Field name as declared in the schema.
   * @param predicate FilterPredicate describing the matching condition.
   * @returns         Uint32Array bitset. Length = ceil(windowSize / 32).
   */
  getFilterBitset(field: string, predicate: FilterPredicate): Uint32Array {
    const f = this.fieldIndex.get(field);
    if (!f) {
      throw new TypeError(
        `getFilterBitset: unknown field '${field}'. ` +
        `Available fields: ${[...this.fieldIndex.keys()].join(', ')}.`,
      );
    }

    // Reject heap-indirected types and i64 (BigInt doesn't fit JS number arithmetic).
    switch (f.type) {
      case 'utf8':
      case 'json':
      case 'bytes':
      case 'i64':
      case 'i32_array':
      case 'f32_array':
        throw new TypeError(
          `getFilterBitset: field '${field}' has type '${f.type}', which is ` +
          `heap-indirected or BigInt-valued. Supported types: ` +
          `i32, u32, f32, f64, u16, u8, bool8, utf8_ref.`,
        );
    }

    const committed  = Atomics.load(this.ctrl, CTRL_COMMIT_SEQ);
    const startSeq   = Math.max(0, committed - this.map.index_capacity);
    const windowSize = committed - startSeq;

    const bs = createBitset(windowSize);
    if (windowSize === 0) return bs;

    // ── Pre-calculate constants — all live outside the hot loop ──────────────
    const ringMask   = this.map.index_capacity - 1;
    const stride     = this.map.record_stride;
    const byteOffset = f.byteOffset;
    const data       = this.data;

    // ── One-time type dispatch — produces a single typed reader closure ───────
    // The switch runs once per getFilterBitset call, not once per record.
    type Reader = (base: number) => number;
    let read: Reader;
    switch (f.type) {
      case 'i32':      read = (b) => data.getInt32(b,    true); break;
      case 'u32':      read = (b) => data.getUint32(b,   true); break;
      case 'f32':      read = (b) => data.getFloat32(b,  true); break;
      case 'f64':      read = (b) => data.getFloat64(b,  true); break;
      case 'u16':      read = (b) => data.getUint16(b,   true); break;
      case 'u8':       read = (b) => data.getUint8(b);          break;
      case 'bool8':    read = (b) => data.getUint8(b);          break;
      case 'utf8_ref': read = (b) => data.getUint32(b,   true); break;
      default:
        // Unreachable: all unsupported types rejected above.
        throw new TypeError(`getFilterBitset: unsupported type '${f.type}'.`);
    }

    // ── Hot loop — single DataView read + predicate test + conditional bit set.
    // No cursor, no object allocation, no per-record type dispatch.
    if (predicate.kind === 'between') {
      const { lo, hi } = predicate;
      for (let seq = startSeq; seq < committed; seq++) {
        const base = INDEX_START + (seq & ringMask) * stride + byteOffset;
        const v = read(base);
        if (v >= lo && v <= hi) {
          const j = seq - startSeq;
          const w = j >>> 5;
          bs[w] = bs[w]! | (1 << (j & 31));
        }
      }
    } else if (predicate.kind === 'eq') {
      const { value } = predicate;
      for (let seq = startSeq; seq < committed; seq++) {
        const base = INDEX_START + (seq & ringMask) * stride + byteOffset;
        if (read(base) === value) {
          const j = seq - startSeq;
          const w = j >>> 5;
          bs[w] = bs[w]! | (1 << (j & 31));
        }
      }
    } else {
      // kind === 'in'
      const { handles } = predicate;
      for (let seq = startSeq; seq < committed; seq++) {
        const base = INDEX_START + (seq & ringMask) * stride + byteOffset;
        if (handles.has(read(base))) {
          const j = seq - startSeq;
          const w = j >>> 5;
          bs[w] = bs[w]! | (1 << (j & 31));
        }
      }
    }

    return bs;
  }

  /**
   * Scan a bitset of matching records and compute per-field min/max "reality"
   * for every numeric field in the schema.
   *
   * This is the second half of the vectorized constraint pipeline:
   *
   *   1. Build one bitset per active predicate with getFilterBitset().
   *   2. Intersect them with computeIntersection() — O(N/32).
   *   3. Call getConstrainedRanges(intersection) to learn the min/max of every
   *      numeric field within that filtered view — drives range-slider bounds.
   *
   * Only records whose bit is set in `intersectionBitset` are visited — no full
   * scan. If the intersection is 1 % of total records, this runs in ~1 % of the
   * time of a na×ve full scan.
   *
   * Architectural constraints (same as getFilterBitset):
   *
   *   Windowed reality  — re-snapshots committedCount from Atomics. Uses the same
   *                       [windowStart, committedCount) window as the bitsets were
   *                       built against. If committedCount has advanced since the
   *                       bitsets were built, bits beyond windowSize are ignored
   *                       (they are zero by construction).
   *   Hot-loop purity   — no RecordCursor, no JS object per record. Readers are
   *                       pre-computed per field as typed closures; the hot loop
   *                       body is an inner loop over O(numericFields) DataView reads.
   *   Float64Array accumulators — parallel min/max arrays for cache-friendly access.
   *
   * @param intersectionBitset  Output of computeIntersection (or a single
   *                            getFilterBitset result). Bit j = seq windowStart+j.
   * @returns  Map of field name → { min, max }. Fields with no finite values in
   *           the matching set are omitted.
   */
  getConstrainedRanges(intersectionBitset: Uint32Array): ConstrainedRanges {
    const committed  = Atomics.load(this.ctrl, CTRL_COMMIT_SEQ);
    const startSeq   = Math.max(0, committed - this.map.index_capacity);
    const windowSize = committed - startSeq;

    if (windowSize === 0 || intersectionBitset.length === 0) return {};

    // ── Collect numeric field readers — one-time type dispatch ────────────────
    // Only inline fixed-width numeric types. utf8_ref handles are ordinal but not
    // meaningful as range stats. i64 is excluded (BigInt ≠ JS number). bool8 is
    // excluded (only 0/1; callers can derive frequency separately if needed).
    type FieldReader = { name: string; byteOffset: number; read: (base: number) => number };
    const readers: FieldReader[] = [];
    const data = this.data;

    for (const [name, f] of this.fieldIndex) {
      let read: (base: number) => number;
      switch (f.type) {
        case 'i32': read = (b) => data.getInt32(b,    true); break;
        case 'u32': read = (b) => data.getUint32(b,   true); break;
        case 'f32': read = (b) => data.getFloat32(b,  true); break;
        case 'f64': read = (b) => data.getFloat64(b,  true); break;
        case 'u16': read = (b) => data.getUint16(b,   true); break;
        case 'u8':  read = (b) => data.getUint8(b);          break;
        default: continue; // skip utf8, utf8_ref, json, bytes, i64, bool8, arrays
      }
      readers.push({ name, byteOffset: f.byteOffset, read });
    }

    if (readers.length === 0) return {};

    // ── Parallel Float64Array accumulators — cache-friendly min/max ───────────
    const n    = readers.length;
    const mins = new Float64Array(n).fill(Infinity);
    const maxs = new Float64Array(n).fill(-Infinity);

    const ringMask = this.map.index_capacity - 1;
    const stride   = this.map.record_stride;

    // ── Hot loop — visits only records set in intersectionBitset ─────────────
    // forEachSet skips zero bitset words in O(1); total work is O(matches × numericFields).
    forEachSet(intersectionBitset, windowSize, (j) => {
      const seq  = startSeq + j;
      const base = INDEX_START + (seq & ringMask) * stride;

      for (let i = 0; i < n; i++) {
        const r = readers[i]!;
        const v = r.read(base + r.byteOffset);
        if (isFinite(v)) {
          if (v < mins[i]!) mins[i] = v;
          if (v > maxs[i]!) maxs[i] = v;
        }
      }
    });

    // ── Collect results — omit fields with no finite values ───────────────────
    const result: ConstrainedRanges = {};
    for (let i = 0; i < n; i++) {
      if (mins[i]! !== Infinity) {
        result[readers[i]!.name] = { min: mins[i]!, max: maxs[i]! };
      }
    }
    return result;
  }

  /**
   * Signal the producer to abort the current stream.
   *
   * Sets CTRL_ABORT = 1 and fires Atomics.notify on READ_CURSOR to wake a
   * producer stalled in waitForIndexSpace(). The producer detects the abort
   * flag on its next loop iteration and throws StrandAbortError.
   *
   * Use this when the consumer needs to terminate the stream before EOS —
   * for example, when the user navigates away, changes the active query, or
   * the main thread encounters an unrecoverable error.
   *
   * After calling signalAbort(), the producer Worker should:
   *   1. Catch StrandAbortError from writeRecordBatch.
   *   2. Call writer.abort() to set STATUS_ERROR.
   *   3. Exit cleanly.
   *
   * Call writer.reset() before reusing the buffer for a new query.
   */
  signalAbort(): void {
    Atomics.store(this.ctrl, CTRL_ABORT, 1);
    Atomics.notify(this.ctrl, CTRL_READ_CURSOR, 1);
  }
}
