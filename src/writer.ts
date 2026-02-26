/**
 * @strand/core — StrandWriter (Producer)
 *
 * The single source of truth for writing records into a Strand buffer.
 *
 * ── Where this runs ──────────────────────────────────────────────────────────
 *
 * MUST be instantiated inside a Web Worker or Node.js worker_threads context.
 * The backpressure stall uses Atomics.wait, which blocks the calling thread.
 * Atomics.wait throws on the browser main thread. If you are on the main
 * thread, you need a non-blocking producer design — that is out of scope for
 * @strand/core v0.1.
 *
 * ── Claim / Commit cycle ─────────────────────────────────────────────────────
 *
 * The consumer (StrandView) is gated solely by COMMIT_SEQ. The producer never
 * makes partial batches visible:
 *
 *   1. encode         — pre-encode all utf8 strings; validate capacity
 *   2. stall          — Atomics.wait until ring has space (backpressure)
 *   3. claim          — Atomics.add(WRITE_SEQ, batchSize)  → batchStart
 *   4. write index    — write fixed-width fields for all records
 *   5. write heap     — write utf8 strings; may emit skip sentinels
 *   6. commit         — Atomics.store(HEAP_COMMIT) then Atomics.store(COMMIT_SEQ)
 *   7. notify         — Atomics.notify(COMMIT_SEQ, 1) once, not per record
 *
 * COMMIT_SEQ is the visibility fence. Nothing below it is half-written.
 *
 * ── Partial-write recovery ───────────────────────────────────────────────────
 *
 * If the Worker crashes after step 3 but before step 6, WRITE_SEQ > COMMIT_SEQ
 * on the next startup. The constructor detects this and rewinds WRITE_SEQ (and
 * HEAP_WRITE) to their last committed positions. The consumer never observes
 * the abandoned records. Streaming resumes from the last clean commit.
 *
 * ── Heap ring and skip sentinels ─────────────────────────────────────────────
 *
 * utf8 fields store [heap_offset: u32][heap_len: u16] in the fixed-width index
 * record. The consumer computes:
 *
 *   physAddress = heapStart + (heap_offset % heap_capacity)
 *
 * The writer guarantees this subarray is always physically contiguous —
 * it never spans the heap ring boundary. When a string would cross the
 * boundary, the writer:
 *
 *   a) Writes a HEAP_SKIP_MAGIC (0xFFFF) sentinel at the current position
 *      (if ≥ 6 bytes remain before the wrap — the sentinel's minimum size).
 *   b) Advances HEAP_WRITE past the pre-wrap padding to the ring origin.
 *   c) Writes the string at the ring origin (physOffset = 0).
 *   d) Stores the post-wrap monotonic heap_offset in the index record.
 *
 * The sentinel is for diagnostic heap scanners. StrandView consumers are
 * unaffected — they never read the heap sequentially.
 */

import {
  CTRL_ARRAY_LEN,
  CTRL_WRITE_SEQ,
  CTRL_COMMIT_SEQ,
  CTRL_READ_CURSOR,
  CTRL_STATUS,
  CTRL_HEAP_WRITE,
  CTRL_HEAP_COMMIT,
  CTRL_ABORT,
  STATUS_IDLE,
  STATUS_STREAMING,
  STATUS_EOS,
  STATUS_ERROR,
  HEAP_SKIP_MAGIC,
  HEAP_SKIP_SIZE,
  INDEX_START,
  heapStart,
} from './constants';
import { readStrandHeader } from './header';
import {
  type FieldDescriptor,
  type StrandMap,
} from './types';

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown when a record's variable-length data exceeds the Strand heap capacity.
 *
 * Two distinct cases:
 *
 *   1. Single field exceeds u16 max (65535 bytes) — heap_len is stored as u16.
 *   2. All utf8 fields combined exceed heap_capacity — the record will never
 *      fit in the ring, regardless of where we start writing.
 *
 * Resolution: increase heap_capacity in computeStrandMap(), or split the
 * offending record across multiple smaller records.
 */
export class StrandCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrandCapacityError';
  }
}

/**
 * Thrown by writeRecordBatch when the consumer signals an abort while the
 * producer is stalled waiting for ring space.
 *
 * The caller (the Worker entry point) should catch this, call writer.abort()
 * to set STATUS_ERROR so the consumer observes a clean failure, and exit.
 */
export class StrandAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrandAbortError';
  }
}

// ─── Public types ─────────────────────────────────────────────────────────────

export type WritableValue = number | bigint | boolean | string | null | undefined;

/**
 * A record to be written. Keys are schema field names; values must be
 * compatible with the field's declared type (see coercion rules in writeOneRecord).
 * Missing fields write zero / empty. Unknown keys are silently ignored.
 */
export type WritableRecord = Readonly<Record<string, WritableValue>>;

// ─── Module-level encoder ─────────────────────────────────────────────────────

// Shared across all StrandWriter instances — TextEncoder.encode() is stateless.
const utf8Encoder = new TextEncoder();

// ─── StrandWriter ─────────────────────────────────────────────────────────────

export class StrandWriter {
  private readonly ctrl:          Int32Array;
  private readonly data:          DataView;
  private readonly sab:           SharedArrayBuffer;
  private readonly map:           StrandMap;
  private readonly fieldIndex:    ReadonlyMap<string, FieldDescriptor>;
  private readonly heapStartByte: number;

  constructor(sab: SharedArrayBuffer) {
    // readStrandHeader validates magic → version → schema fingerprint.
    // Throws StrandHeaderError on any mismatch — no partial state.
    this.map          = readStrandHeader(sab);
    this.sab          = sab;
    this.ctrl         = new Int32Array(sab, 0, CTRL_ARRAY_LEN);
    this.data         = new DataView(sab);
    this.heapStartByte = heapStart(this.map.index_capacity, this.map.record_stride);
    this.fieldIndex   = new Map(this.map.schema.fields.map(f => [f.name, f]));

    // ── Partial-write recovery ────────────────────────────────────────────────
    //
    // If the previous producer crashed between claim (Atomics.add WRITE_SEQ)
    // and commit (Atomics.store COMMIT_SEQ), those claimed slots are orphaned.
    // Reset both cursors to the last committed state so the next batch starts
    // cleanly without corrupting the ring.
    const writeSeq  = Atomics.load(this.ctrl, CTRL_WRITE_SEQ);
    const commitSeq = Atomics.load(this.ctrl, CTRL_COMMIT_SEQ);
    if (writeSeq !== commitSeq) {
      Atomics.store(this.ctrl, CTRL_WRITE_SEQ, commitSeq);
    }

    // Same for heap cursors.
    const heapWrite  = Atomics.load(this.ctrl, CTRL_HEAP_WRITE);
    const heapCommit = Atomics.load(this.ctrl, CTRL_HEAP_COMMIT);
    if (heapWrite !== heapCommit) {
      Atomics.store(this.ctrl, CTRL_HEAP_WRITE, heapCommit);
    }
  }

  // ── writeRecordBatch ──────────────────────────────────────────────────────

  /**
   * Write a batch of records into the Strand buffer.
   *
   * Blocks the calling thread if the index ring is full (backpressure stall).
   * Call only from a Worker thread — Atomics.wait throws on the main thread.
   *
   * The batch is atomic from the consumer's perspective. Records become
   * visible only when COMMIT_SEQ advances at the end of this call.
   * No partial batches are ever observable.
   *
   * @throws StrandCapacityError if any record's total heap bytes exceed heap_capacity.
   * @throws TypeError           if a field value has an incompatible type.
   */
  writeRecordBatch(records: WritableRecord[]): void {
    if (records.length === 0) return;

    const status = Atomics.load(this.ctrl, CTRL_STATUS);
    if (status === STATUS_ERROR) {
      throw new Error(
        'Cannot write to an errored Strand buffer. Call reset() to start fresh.',
      );
    }
    if (status === STATUS_EOS) {
      throw new Error(
        'Cannot write after finalize(). Call reset() to start fresh.',
      );
    }

    // ── Phase 1: Encode utf8 strings, validate heap capacity ──────────────
    //
    // All encoding happens before any Atomics mutations. If a record exceeds
    // heap_capacity, we throw here — no index slots are claimed, no heap
    // bytes are touched.
    const encodedBatch = this.encodeHeapFields(records);

    // ── Phase 2: Backpressure stall ────────────────────────────────────────
    //
    // Block until the index ring has room for the full batch.
    this.waitForIndexSpace(records.length);

    // ── Phase 3: Claim index slots ─────────────────────────────────────────
    //
    // Atomics.add returns the value BEFORE the addition — this is batchStart.
    // WRITE_SEQ is now batchStart + records.length, but these slots are still
    // invisible to the consumer (COMMIT_SEQ has not moved).
    const batchStart = Atomics.add(this.ctrl, CTRL_WRITE_SEQ, records.length);

    // ── Phase 4: Write all records to index and heap ───────────────────────
    for (let i = 0; i < records.length; i++) {
      this.writeOneRecord(batchStart + i, records[i]!, encodedBatch[i]!);
    }

    // ── Phase 5: Commit ────────────────────────────────────────────────────
    //
    // Advance HEAP_COMMIT to match HEAP_WRITE first. This ensures diagnostic
    // heap scanners see a consistent committed range.
    //
    // Then advance COMMIT_SEQ. This is the consumer's gate. Only after this
    // store will StrandView.committedCount() reflect the new records.
    //
    // Order matters: HEAP_COMMIT before COMMIT_SEQ. A consumer woken by
    // Atomics.notify will read COMMIT_SEQ, then read heap bytes. If HEAP_COMMIT
    // weren't already stable, a diagnostic tool could observe a race.
    Atomics.store(this.ctrl, CTRL_HEAP_COMMIT, Atomics.load(this.ctrl, CTRL_HEAP_WRITE));
    Atomics.store(this.ctrl, CTRL_COMMIT_SEQ,  batchStart + records.length);

    // ── Phase 6: Notify once ───────────────────────────────────────────────
    //
    // Wake exactly one waiting consumer. The consumer drains everything from
    // its last cursor to the new COMMIT_SEQ, then re-arms its wait.
    // We do NOT call Atomics.notify per record — that would thrash the consumer
    // thread with thousands of wakeups per second on a fast stream.
    Atomics.notify(this.ctrl, CTRL_COMMIT_SEQ, 1);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Transition to STREAMING status. Call before the first writeRecordBatch.
   * Notifies the consumer so it can wake from an idle wait and check status.
   */
  begin(): void {
    Atomics.store(this.ctrl, CTRL_STATUS, STATUS_STREAMING);
    Atomics.notify(this.ctrl, CTRL_COMMIT_SEQ, 1);
  }

  /**
   * Mark the stream as complete. No more records will be written.
   * Wakes the consumer so it can detect end-of-stream without waiting
   * for a timeout.
   */
  finalize(): void {
    Atomics.store(this.ctrl, CTRL_STATUS, STATUS_EOS);
    Atomics.notify(this.ctrl, CTRL_COMMIT_SEQ, 1);
  }

  /**
   * Mark the stream as errored and wake the consumer.
   * The consumer will observe status === 'error' on its next read.
   */
  abort(): void {
    Atomics.store(this.ctrl, CTRL_STATUS, STATUS_ERROR);
    Atomics.notify(this.ctrl, CTRL_COMMIT_SEQ, 1);
  }

  /**
   * Flush all ring cursors to zero for a new query on the same buffer.
   *
   * The static header (magic, schema, capacities) is not touched.
   * The consumer MUST reset its own cursor independently. Signal the consumer
   * out-of-band (e.g. via postMessage) before calling reset() so it does not
   * attempt to read during the transition.
   */
  reset(): void {
    Atomics.store(this.ctrl, CTRL_STATUS,      STATUS_IDLE);
    Atomics.store(this.ctrl, CTRL_WRITE_SEQ,   0);
    Atomics.store(this.ctrl, CTRL_COMMIT_SEQ,  0);
    Atomics.store(this.ctrl, CTRL_READ_CURSOR, 0);
    Atomics.store(this.ctrl, CTRL_HEAP_WRITE,  0);
    Atomics.store(this.ctrl, CTRL_HEAP_COMMIT, 0);
    Atomics.store(this.ctrl, CTRL_ABORT,       0);
  }

  // ── Private: encode ───────────────────────────────────────────────────────

  /**
   * Pre-encode all utf8 fields for a batch and validate capacity.
   *
   * Returns a parallel array of Maps: one Map per record, keyed by field name,
   * containing the encoded Uint8Array for each utf8 field.
   *
   * Capacity checks performed here (before any Atomics mutations):
   *   - Single field > 65535 bytes → StrandCapacityError (heap_len is u16)
   *   - Record total heap bytes > heap_capacity → StrandCapacityError
   *     (the record can never fit regardless of wrap position)
   */
  private encodeHeapFields(
    records: WritableRecord[],
  ): Array<Map<string, Uint8Array>> {
    const result: Array<Map<string, Uint8Array>> = [];
    const utf8Fields = this.map.schema.fields.filter(f => f.type === 'utf8');

    for (let i = 0; i < records.length; i++) {
      const record  = records[i]!;
      const encoded = new Map<string, Uint8Array>();
      let   totalHeapBytes = 0;

      for (const field of utf8Fields) {
        const value = record[field.name];

        if (value === null || value === undefined || value === '') {
          encoded.set(field.name, new Uint8Array(0));
          continue;
        }

        if (typeof value !== 'string') {
          throw new TypeError(
            `Field '${field.name}' (utf8) expects a string or null; ` +
            `got ${typeof value}.`,
          );
        }

        const bytes = utf8Encoder.encode(value);

        // heap_len is stored as u16 — 65535 byte hard ceiling per field.
        if (bytes.length > 0xffff) {
          throw new StrandCapacityError(
            `Field '${field.name}' encodes to ${bytes.length} bytes. ` +
            `Maximum is 65535 (heap_len is stored as u16). ` +
            `Split the field or truncate the string before writing.`,
          );
        }

        encoded.set(field.name, bytes);
        totalHeapBytes += bytes.length;
      }

      // A record whose total heap bytes exceed heap_capacity can never fit —
      // even starting at the ring origin there isn't enough contiguous space.
      if (totalHeapBytes > this.map.heap_capacity) {
        throw new StrandCapacityError(
          `Record ${i} requires ${totalHeapBytes} total heap bytes across its utf8 ` +
          `fields, which exceeds heap_capacity (${this.map.heap_capacity} bytes). ` +
          `Increase heap_capacity in computeStrandMap(), ` +
          `or split the record into smaller chunks.`,
        );
      }

      result.push(encoded);
    }

    return result;
  }

  // ── Private: backpressure ─────────────────────────────────────────────────

  /**
   * Block until the index ring has at least `needed` free slots.
   *
   * "Free" means: claimed-but-unacknowledged records < index_capacity.
   * The consumer advances READ_CURSOR in acknowledgeRead(), which wakes
   * the Atomics.wait here.
   *
   * ── Abort path ───────────────────────────────────────────────────────────
   *
   * If the consumer sets CTRL_ABORT = 1 (via StrandView.signalAbort()), the
   * accompanying Atomics.notify on READ_CURSOR wakes the wait. On the next
   * loop iteration we detect the abort bit and throw StrandAbortError.
   *
   * The 200 ms timeout is a safety net for the case where the consumer
   * disappears without calling signalAbort() (e.g., the page is closed or
   * the main thread crashes). The producer re-checks CTRL_ABORT on each
   * wake-up and exits within 200 ms of a consumer going away.
   *
   * Safe to call only from a Worker thread (Atomics.wait throws on the
   * browser main thread; Node.js main thread is the exception but the same
   * rule applies here for forward-compatibility).
   *
   * @throws StrandAbortError  when CTRL_ABORT is set by the consumer.
   */
  private waitForIndexSpace(needed: number): void {
    const capacity = this.map.index_capacity;

    while (true) {
      const writeSeq   = Atomics.load(this.ctrl, CTRL_WRITE_SEQ);
      const readCursor = Atomics.load(this.ctrl, CTRL_READ_CURSOR);

      if (writeSeq - readCursor + needed <= capacity) return;

      // Check the abort flag before sleeping.
      if (Atomics.load(this.ctrl, CTRL_ABORT) !== 0) {
        throw new StrandAbortError(
          'Strand stream aborted: the consumer called signalAbort() while the ' +
          'producer was stalled on a full index ring. ' +
          'Catch StrandAbortError in the Worker and call writer.abort() to ' +
          'mark the stream as errored before exiting.',
        );
      }

      // Ring is full. Sleep up to 200 ms for the consumer to advance READ_CURSOR.
      // signalAbort() fires Atomics.notify(READ_CURSOR) as well, so we wake
      // promptly even on the abort path.
      Atomics.wait(this.ctrl, CTRL_READ_CURSOR, readCursor, 200);
      // On return ('ok', 'not-equal', or 'timed-out'), loop and re-check.
    }
  }

  // ── Private: write one record ─────────────────────────────────────────────

  /**
   * Write one record's fields into the index ring and heap.
   * Must be called after the index slot is claimed (seq < WRITE_SEQ).
   */
  private writeOneRecord(
    seq:        number,
    record:     WritableRecord,
    heapFields: Map<string, Uint8Array>,
  ): void {
    // Fast modulo for power-of-2 index_capacity.
    const slot         = seq & (this.map.index_capacity - 1);
    const recordOffset = INDEX_START + slot * this.map.record_stride;

    for (const field of this.map.schema.fields) {
      const value  = record[field.name] ?? null;
      const offset = recordOffset + field.byteOffset;

      switch (field.type) {
        case 'i32':
          this.data.setInt32(offset, toInt32(value, field.name), /* le */ true);
          break;

        case 'u32':
          this.data.setUint32(offset, toUint32(value, field.name), true);
          break;

        case 'i64':
          this.data.setBigInt64(offset, toInt64(value, field.name), true);
          break;

        case 'f32':
          this.data.setFloat32(offset, toFloat(value, field.name), true);
          break;

        case 'f64':
          this.data.setFloat64(offset, toFloat(value, field.name), true);
          break;

        case 'u16':
          this.data.setUint16(offset, toUint16(value, field.name), true);
          break;

        case 'u8':
          this.data.setUint8(offset, toUint8(value, field.name));
          break;

        case 'bool8':
          this.data.setUint8(offset, toBool(value, field.name) ? 1 : 0);
          break;

        case 'utf8_ref':
          // utf8_ref stores a u32 intern table handle.
          this.data.setUint32(offset, toUint32(value, field.name), true);
          break;

        case 'utf8': {
          const encoded = heapFields.get(field.name) ?? new Uint8Array(0);
          const { heapOffset, physOffset } = this.claimHeap(encoded.length);

          // Write the string bytes into the heap (zero copy from encoder output).
          if (encoded.length > 0) {
            new Uint8Array(this.sab, this.heapStartByte + physOffset, encoded.length)
              .set(encoded);
          }

          // Write the two-field heap pointer into the fixed-width record:
          //   [heap_offset: u32]  monotonic cursor value
          //   [heap_len:    u16]  string byte length
          this.data.setUint32(offset,     heapOffset,     true);
          this.data.setUint16(offset + 4, encoded.length, true);
          break;
        }
      }
    }
  }

  // ── Private: heap management ──────────────────────────────────────────────

  /**
   * Claim heap space for `byteLen` bytes.
   *
   * Returns:
   *   heapOffset  — monotonic cursor value to store in the index record.
   *                 Consumer computes: physAddress = heapStart + (heapOffset % heap_capacity)
   *   physOffset  — physical byte offset within the heap region for writing.
   *
   * Wrap handling:
   *   When `byteLen` would extend past the physical end of the heap ring,
   *   this method emits a skip sentinel at the current position and advances
   *   HEAP_WRITE to the ring origin. The string is then written there.
   *
   *   Sentinel layout at the pre-wrap position:
   *     [HEAP_SKIP_MAGIC: u16 = 0xFFFF]
   *     [skip_bytes:      u32]          bytes from end of sentinel to ring boundary
   *
   *   If fewer than HEAP_SKIP_SIZE (6) bytes remain before the wrap, the
   *   sentinel is omitted — the bytes are silently padded. This is a rare
   *   edge case that only occurs when the ring boundary falls within 5 bytes
   *   of the current write cursor.
   */
  private claimHeap(byteLen: number): { heapOffset: number; physOffset: number } {
    // Load current monotonic cursor. For single-producer this Atomics.load
    // is equivalent to a plain read, but the Atomics API is used throughout
    // for correctness and to prevent compiler re-ordering.
    //
    // CTRL_HEAP_WRITE is stored in an Int32Array. After accumulating more than
    // 2^31 bytes of heap writes, Atomics.load returns a negative signed value.
    // The >>> 0 coercion reinterprets the bit pattern as an unsigned 32-bit
    // integer, giving the correct monotonic position. The consumer reads the
    // heap_offset field via getUint32 (unsigned), so both sides are consistent.
    const heapWrite       = Atomics.load(this.ctrl, CTRL_HEAP_WRITE) >>> 0;
    const physCursor      = heapWrite % this.map.heap_capacity;
    const bytesBeforeWrap = this.map.heap_capacity - physCursor;

    if (byteLen === 0) {
      // Empty string: no heap bytes needed. Store the current cursor as the
      // offset (heap_len = 0 means the consumer reads zero bytes from here).
      return { heapOffset: heapWrite, physOffset: physCursor };
    }

    if (byteLen <= bytesBeforeWrap) {
      // ── Happy path: string fits before the ring boundary ─────────────────
      Atomics.add(this.ctrl, CTRL_HEAP_WRITE, byteLen);
      return { heapOffset: heapWrite, physOffset: physCursor };
    }

    // ── Wrap path: string does not fit before the ring boundary ──────────
    //
    // We cannot split the string across the ring boundary — the consumer
    // requires a contiguous subarray. Instead:
    //   1. Write a skip sentinel at the current position (if space allows).
    //   2. Skip HEAP_WRITE forward to the ring origin.
    //   3. The string is written at physOffset = 0.

    if (bytesBeforeWrap >= HEAP_SKIP_SIZE) {
      // Enough room for the sentinel. Write it.
      const sentinelView = new DataView(
        this.sab,
        this.heapStartByte + physCursor,
        HEAP_SKIP_SIZE,
      );
      sentinelView.setUint16(0, HEAP_SKIP_MAGIC,                       /* le */ true);
      sentinelView.setUint32(2, bytesBeforeWrap - HEAP_SKIP_SIZE,               true);
    }
    // If bytesBeforeWrap < HEAP_SKIP_SIZE, we silently lose those bytes.
    // A diagnostic scanner sees trailing zeros at the ring boundary.

    // The string's monotonic heap_offset is the position AFTER the pre-wrap
    // padding. Its physical address is heapStart + (wrappedOffset % heapCapacity) = 0.
    const wrappedOffset = heapWrite + bytesBeforeWrap;
    Atomics.add(this.ctrl, CTRL_HEAP_WRITE, bytesBeforeWrap + byteLen);

    return { heapOffset: wrappedOffset, physOffset: 0 };
  }
}

// ─── Value coercion helpers ───────────────────────────────────────────────────
//
// These intentionally allow cross-type coercion (bigint → number, number → bigint)
// because calling code often works with plain JS numbers even for i64 fields.
// Type errors are thrown for completely incompatible inputs (e.g. string → i32).

function toInt32(v: WritableValue, name: string): number {
  if (v == null) return 0;
  if (typeof v === 'number')  return v | 0;
  if (typeof v === 'bigint')  return Number(v) | 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new TypeError(`Field '${name}' (i32) received ${typeof v}; expected number.`);
}

function toUint32(v: WritableValue, name: string): number {
  if (v == null) return 0;
  if (typeof v === 'number')  return v >>> 0;
  if (typeof v === 'bigint')  return Number(v) >>> 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new TypeError(`Field '${name}' (u32/utf8_ref) received ${typeof v}; expected number.`);
}

function toInt64(v: WritableValue, name: string): bigint {
  if (v == null) return 0n;
  if (typeof v === 'bigint')  return v;
  if (typeof v === 'number')  return BigInt(Math.trunc(v));
  if (typeof v === 'boolean') return v ? 1n : 0n;
  throw new TypeError(`Field '${name}' (i64) received ${typeof v}; expected bigint or number.`);
}

function toFloat(v: WritableValue, name: string): number {
  if (v == null) return 0;
  if (typeof v === 'number')  return v;
  if (typeof v === 'bigint')  return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new TypeError(`Field '${name}' (f32/f64) received ${typeof v}; expected number.`);
}

function toUint16(v: WritableValue, name: string): number {
  if (v == null) return 0;
  if (typeof v === 'number')  return (v >>> 0) & 0xffff;
  if (typeof v === 'bigint')  return Number(v) & 0xffff;
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new TypeError(`Field '${name}' (u16) received ${typeof v}; expected number.`);
}

function toUint8(v: WritableValue, name: string): number {
  if (v == null) return 0;
  if (typeof v === 'number')  return (v >>> 0) & 0xff;
  if (typeof v === 'bigint')  return Number(v) & 0xff;
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new TypeError(`Field '${name}' (u8) received ${typeof v}; expected number.`);
}

function toBool(v: WritableValue, name: string): boolean {
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number')  return v !== 0;
  if (typeof v === 'bigint')  return v !== 0n;
  throw new TypeError(`Field '${name}' (bool8) received ${typeof v}; expected boolean.`);
}
