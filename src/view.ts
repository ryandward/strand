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
  STATUS_STREAMING,
  STATUS_EOS,
  STATUS_ERROR,
  heapStart,
} from './constants';
import { readStrandHeader } from './header';
import {
  FIELD_BYTE_WIDTHS,
  type FieldDescriptor,
  type StrandMap,
  type StrandStatus,
} from './types';

// ─── Module-level shared decoder ──────────────────────────────────────────────

// TextDecoder is stateless (when not used in streaming mode), so one instance
// is safe to reuse across all getString() calls across all RecordCursor instances.
const utf8Decoder = new TextDecoder();

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

  /** @internal — use StrandView.allocateCursor() */
  constructor(
    private readonly _ctrl:          Int32Array,
    private readonly _data:          DataView,
    private readonly _sab:           SharedArrayBuffer,
    private readonly _fieldIndex:    ReadonlyMap<string, FieldDescriptor>,
    private readonly _heapStartByte: number,
    private readonly _heapCapacity:  number,
    private readonly _internTable:   readonly string[],
    private readonly _indexCapacity: number,
    private readonly _recordStride:  number,
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
      this.seq = seq;
    }

    // Fast modulo for power-of-2 ring capacity.
    this._recordOffset = INDEX_START + (seq & (this._indexCapacity - 1)) * this._recordStride;
    return true;
  }

  // ── Typed accessors ────────────────────────────────────────────────────────
  // Each returns null if the field does not exist or has the wrong type.

  getI32(name: string): number | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'i32') return null;
    return this._data.getInt32(this._recordOffset + f.byteOffset, /* le */ true);
  }

  getU32(name: string): number | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'u32') return null;
    return this._data.getUint32(this._recordOffset + f.byteOffset, true);
  }

  getI64(name: string): bigint | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'i64') return null;
    return this._data.getBigInt64(this._recordOffset + f.byteOffset, true);
  }

  getF32(name: string): number | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'f32') return null;
    return this._data.getFloat32(this._recordOffset + f.byteOffset, true);
  }

  getF64(name: string): number | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'f64') return null;
    return this._data.getFloat64(this._recordOffset + f.byteOffset, true);
  }

  getU16(name: string): number | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'u16') return null;
    return this._data.getUint16(this._recordOffset + f.byteOffset, true);
  }

  getU8(name: string): number | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'u8') return null;
    return this._data.getUint8(this._recordOffset + f.byteOffset);
  }

  getBool(name: string): boolean | null {
    const f = this._fieldIndex.get(name);
    if (!f || f.type !== 'bool8') return null;
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

    // Zero-copy until this point: bytes lives in the SAB, not a copy.
    const bytes = new Uint8Array(this._sab, physOffset, heapLen);
    const decoded = utf8Decoder.decode(bytes);
    this._stringCache.set(name, decoded);
    return decoded;
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

    const handle = this._data.getUint32(this._recordOffset + f.byteOffset, true);
    return this._internTable[handle] ?? null;
  }

  /**
   * Generic accessor. Returns the most appropriate JS type for the field:
   *   numeric types → number
   *   i64           → bigint
   *   bool8         → boolean
   *   utf8          → string (decoded from heap on read, cached per record)
   *   utf8_ref      → string (resolved from intern table on read)
   *   unknown field → null
   */
  get(name: string): number | bigint | boolean | string | null {
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
      case 'utf8':     return this.getString(name);
      case 'utf8_ref': return this.getRef(name);
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
 */
export class StrandView {
  /** The underlying SAB. Pass to Workers via postMessage — zero-copy. */
  readonly sab: SharedArrayBuffer;

  /** StrandMap reconstructed from the binary header. */
  readonly map: StrandMap;

  private readonly ctrl:          Int32Array;
  private readonly data:          DataView;
  private readonly fieldIndex:    ReadonlyMap<string, FieldDescriptor>;
  private readonly heapStartByte: number;
  private readonly internTable:   readonly string[];

  constructor(sab: SharedArrayBuffer, internTable: readonly string[] = []) {
    // readStrandHeader throws on any validation failure.
    // No partial state is possible: either the view is fully valid or it throws.
    this.map          = readStrandHeader(sab);
    this.sab          = sab;
    this.ctrl         = new Int32Array(sab, 0, CTRL_ARRAY_LEN);
    this.data         = new DataView(sab);
    this.internTable  = internTable;
    this.heapStartByte = heapStart(this.map.index_capacity, this.map.record_stride);
    this.fieldIndex   = new Map(this.map.schema.fields.map(f => [f.name, f]));
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
      case STATUS_STREAMING: return 'streaming';
      case STATUS_EOS:       return 'eos';
      case STATUS_ERROR:     return 'error';
      default:               return 'idle';
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
      this.internTable,
      this.map.index_capacity,
      this.map.record_stride,
    );
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
   * This signals to the producer that records [0..upTo) have been processed
   * and their ring slots may be reused. If the producer was stalled waiting
   * for ring space, this call unblocks it.
   *
   * Only call this after you are done reading all records up to (not including)
   * `upTo`. Do not call with a value higher than committedCount.
   */
  acknowledgeRead(upTo: number): void {
    const committed = Atomics.load(this.ctrl, CTRL_COMMIT_SEQ);
    if (upTo > committed) {
      throw new RangeError(
        `acknowledgeRead(${upTo}) exceeds committedCount (${committed}). ` +
        `Only acknowledge records that have already been committed.`,
      );
    }
    Atomics.store(this.ctrl, CTRL_READ_CURSOR, upTo);
    Atomics.notify(this.ctrl, CTRL_READ_CURSOR, 1);
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
