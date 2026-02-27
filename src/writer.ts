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
  CTRL_CONSUMER_BASE,
  MAX_CONSUMERS,
  CONSUMER_SLOT_VACANT,
  STATUS_INITIALIZING,
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
  FIELD_FLAG_NULLABLE,
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

export type WritableValue = number | bigint | boolean | string | Uint8Array | Int32Array | Float32Array | object | null | undefined;

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
  /** Number of null-bitmap bytes at the start of each record slot. 0 for schemas with no nullable fields. */
  private readonly bitmapBytes:   number;

  constructor(sab: SharedArrayBuffer) {
    // readStrandHeader validates magic → version → schema fingerprint.
    // Throws StrandHeaderError on any mismatch — no partial state.
    this.map          = readStrandHeader(sab);
    this.sab          = sab;
    this.ctrl         = new Int32Array(sab, 0, CTRL_ARRAY_LEN);
    this.data         = new DataView(sab);
    this.heapStartByte = heapStart(this.map.index_capacity, this.map.record_stride);
    this.fieldIndex   = new Map(this.map.schema.fields.map(f => [f.name, f]));
    const nullableCount = this.map.schema.fields.filter(f => f.flags & FIELD_FLAG_NULLABLE).length;
    this.bitmapBytes  = nullableCount > 0 ? Math.ceil(nullableCount / 8) : 0;

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

    // Mark the buffer as owned by an initializing producer. This distinguishes
    // STATUS_INITIALIZING (alive, not yet writing) from STATUS_EOS / STATUS_ERROR
    // left behind by a previous run. The consumer can check status when seq=0
    // and know whether to wait or give up.
    Atomics.store(this.ctrl, CTRL_STATUS, STATUS_INITIALIZING);
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
   *
   * Uses Atomics.compareExchange to only transition STREAMING → EOS.
   * If the status is already STATUS_ERROR (abort() raced finalize(), or the
   * consumer signalled an abort), the CAS fails silently — ERROR is terminal
   * and cannot be retroactively declared clean.
   */
  finalize(): void {
    Atomics.compareExchange(this.ctrl, CTRL_STATUS, STATUS_STREAMING, STATUS_EOS);
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

  // ── WASM Write Interface ──────────────────────────────────────────────────
  //
  // The claim/commit protocol lets any code holding a SAB reference (WASM
  // linear memory, typed-array views, native extensions) write directly into
  // ring slots without crossing the JS serialization layer on every record.
  //
  // Protocol (fixed-width fields):
  //   1. const { slotOffset, seq } = writer.claimSlot()
  //   2. [write fields: new DataView(sab).setUint32(slotOffset + byteOffset, v, true)]
  //   3. writer.commitSlot(seq)
  //
  // Protocol (variable-length fields):
  //   1. const { slotOffset, seq }       = writer.claimSlot()
  //   2. const { physOffset, monoOffset } = writer.claimHeapBytes(byteLen)
  //   3. [write string: new Uint8Array(sab, heapStart + physOffset, byteLen).set(bytes)]
  //   4. [store heap pointer: setUint32(slotOffset + field.byteOffset, monoOffset, true)]
  //   5. [store heap length:  setUint16(slotOffset + field.byteOffset + 4, byteLen, true)]
  //   6. writer.commitHeap()
  //   7. writer.commitSlot(seq)
  //
  // For batch writes: claimSlots(N) + commitSlots(fromSeq, N).

  /**
   * Claim one ring slot and return its absolute SAB byte offset.
   *
   * Blocks for backpressure if the ring is full (same semantics as
   * writeRecordBatch). Zero-fills the null bitmap bytes at the slot start.
   *
   * @returns { slotOffset } — absolute byte in the SAB where the record
   *          starts. Write field values at slotOffset + field.byteOffset.
   *          { seq } — sequence number; pass to commitSlot() when done.
   */
  claimSlot(): { slotOffset: number; seq: number } {
    const status = Atomics.load(this.ctrl, CTRL_STATUS);
    if (status === STATUS_ERROR) {
      throw new Error('Cannot write to an errored Strand buffer. Call reset() to start fresh.');
    }
    if (status === STATUS_EOS) {
      throw new Error('Cannot write after finalize(). Call reset() to start fresh.');
    }

    this.waitForIndexSpace(1);

    const seq        = Atomics.add(this.ctrl, CTRL_WRITE_SEQ, 1);
    const slot       = seq & (this.map.index_capacity - 1);
    const slotOffset = INDEX_START + slot * this.map.record_stride;

    // Zero-fill null bitmap bytes — a slot reused from a ring lap may have
    // stale bits set. The caller sets bits for nullable fields that it writes.
    if (this.bitmapBytes > 0) {
      for (let b = 0; b < this.bitmapBytes; b++) {
        this.data.setUint8(slotOffset + b, 0);
      }
    }

    return { slotOffset, seq };
  }

  /**
   * Commit a single slot claimed with claimSlot().
   *
   * Asserts seq === current COMMIT_SEQ — slots must be committed in claim
   * order to keep the consumer's visibility fence contiguous.
   *
   * @throws RangeError if seq is not the next expected commit position.
   */
  commitSlot(seq: number): void {
    const current = Atomics.load(this.ctrl, CTRL_COMMIT_SEQ);
    if (seq !== current) {
      throw new RangeError(
        `commitSlot(${seq}): out-of-order commit. ` +
        `Expected seq ${current}. ` +
        `Slots must be committed in the order they were claimed.`,
      );
    }
    Atomics.store(this.ctrl, CTRL_HEAP_COMMIT, Atomics.load(this.ctrl, CTRL_HEAP_WRITE));
    Atomics.store(this.ctrl, CTRL_COMMIT_SEQ, seq + 1);
    Atomics.notify(this.ctrl, CTRL_COMMIT_SEQ, 1);
  }

  /**
   * Claim `count` ring slots in one atomic operation.
   *
   * Returns an array of { slotOffset, seq } — one entry per slot, in order.
   * Zero-fills the null bitmap bytes in each slot.
   *
   * Use commitSlots(claims[0].seq, count) to commit the full batch.
   */
  claimSlots(count: number): ReadonlyArray<{ slotOffset: number; seq: number }> {
    if (count <= 0) return [];

    const status = Atomics.load(this.ctrl, CTRL_STATUS);
    if (status === STATUS_ERROR) {
      throw new Error('Cannot write to an errored Strand buffer. Call reset() to start fresh.');
    }
    if (status === STATUS_EOS) {
      throw new Error('Cannot write after finalize(). Call reset() to start fresh.');
    }

    this.waitForIndexSpace(count);

    const batchStart = Atomics.add(this.ctrl, CTRL_WRITE_SEQ, count);
    const claims: Array<{ slotOffset: number; seq: number }> = [];

    for (let i = 0; i < count; i++) {
      const seq        = batchStart + i;
      const slot       = seq & (this.map.index_capacity - 1);
      const slotOffset = INDEX_START + slot * this.map.record_stride;

      if (this.bitmapBytes > 0) {
        for (let b = 0; b < this.bitmapBytes; b++) {
          this.data.setUint8(slotOffset + b, 0);
        }
      }

      claims.push({ slotOffset, seq });
    }

    return claims;
  }

  /**
   * Atomically commit `count` slots previously claimed with claimSlots().
   *
   * Asserts fromSeq === current COMMIT_SEQ (ordering guard).
   *
   * @throws RangeError if fromSeq is not the next expected commit position.
   */
  commitSlots(fromSeq: number, count: number): void {
    const current = Atomics.load(this.ctrl, CTRL_COMMIT_SEQ);
    if (fromSeq !== current) {
      throw new RangeError(
        `commitSlots(${fromSeq}, ${count}): out-of-order commit. ` +
        `Expected fromSeq ${current}. ` +
        `Slots must be committed in the order they were claimed.`,
      );
    }
    Atomics.store(this.ctrl, CTRL_HEAP_COMMIT, Atomics.load(this.ctrl, CTRL_HEAP_WRITE));
    Atomics.store(this.ctrl, CTRL_COMMIT_SEQ, fromSeq + count);
    Atomics.notify(this.ctrl, CTRL_COMMIT_SEQ, 1);
  }

  /**
   * Claim `byteLen` bytes in the heap ring for a variable-length field.
   *
   * Handles the heap ring boundary (skip sentinel) transparently.
   *
   * @returns { physOffset } — physical SAB byte offset relative to heap start.
   *          Write string bytes at sab[heapStart + physOffset ... + byteLen].
   *          { monoOffset } — monotonic cursor value to store in the index
   *          record's heap_offset u32 (field.byteOffset + 0).
   *
   * Wire format for utf8/json fields in the index record:
   *   [monoOffset: u32 at field.byteOffset]
   *   [byteLen:    u16 at field.byteOffset + 4]
   */
  claimHeapBytes(byteLen: number): { physOffset: number; monoOffset: number } {
    const { heapOffset, physOffset } = this.claimHeap(byteLen);
    return { physOffset, monoOffset: heapOffset };
  }

  /**
   * Advance CTRL_HEAP_COMMIT to match the current CTRL_HEAP_WRITE.
   *
   * Call this after all claimHeapBytes() + heap writes for a slot or batch,
   * and before the corresponding commitSlot() / commitSlots(). This ensures
   * diagnostic heap scanners see a consistent committed range, and preserves
   * the ordering invariant: HEAP_COMMIT is stable before COMMIT_SEQ advances.
   */
  commitHeap(): void {
    Atomics.store(this.ctrl, CTRL_HEAP_COMMIT, Atomics.load(this.ctrl, CTRL_HEAP_WRITE));
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
    Atomics.store(this.ctrl, CTRL_STATUS,      STATUS_INITIALIZING);
    Atomics.store(this.ctrl, CTRL_WRITE_SEQ,   0);
    Atomics.store(this.ctrl, CTRL_COMMIT_SEQ,  0);
    Atomics.store(this.ctrl, CTRL_READ_CURSOR, 0);
    Atomics.store(this.ctrl, CTRL_HEAP_WRITE,  0);
    Atomics.store(this.ctrl, CTRL_HEAP_COMMIT, 0);
    Atomics.store(this.ctrl, CTRL_ABORT,       0);
    for (let i = 0; i < MAX_CONSUMERS; i++) {
      Atomics.store(this.ctrl, CTRL_CONSUMER_BASE + i, CONSUMER_SLOT_VACANT);
    }
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
    const varLenFields = this.map.schema.fields.filter(
      f => f.type === 'utf8' || f.type === 'json' ||
           f.type === 'bytes' || f.type === 'i32_array' || f.type === 'f32_array',
    );

    for (let i = 0; i < records.length; i++) {
      const record  = records[i]!;
      const encoded = new Map<string, Uint8Array>();
      let   totalHeapBytes = 0;

      for (const field of varLenFields) {
        const rawValue = record[field.name];

        // ── Typed-array heap types ─────────────────────────────────────────
        if (field.type === 'bytes' || field.type === 'i32_array' || field.type === 'f32_array') {
          if (rawValue == null) {
            encoded.set(field.name, new Uint8Array(0));
            continue;
          }

          let bytes: Uint8Array;
          if (rawValue instanceof Uint8Array) {
            bytes = rawValue;
          } else if (rawValue instanceof Int32Array) {
            bytes = new Uint8Array(rawValue.buffer, rawValue.byteOffset, rawValue.byteLength);
          } else if (rawValue instanceof Float32Array) {
            bytes = new Uint8Array(rawValue.buffer, rawValue.byteOffset, rawValue.byteLength);
          } else if (Array.isArray(rawValue)) {
            // Plain number[] — convert to the appropriate typed array first.
            if (field.type === 'bytes') {
              bytes = new Uint8Array(rawValue as number[]);
            } else if (field.type === 'i32_array') {
              const ta = new Int32Array(rawValue as number[]);
              bytes = new Uint8Array(ta.buffer);
            } else {
              const ta = new Float32Array(rawValue as number[]);
              bytes = new Uint8Array(ta.buffer);
            }
          } else {
            throw new TypeError(
              `Field '${field.name}' (${field.type}) expects a typed array or number[]; ` +
              `got ${typeof rawValue}.`,
            );
          }

          if (bytes.length > 0xffff) {
            throw new StrandCapacityError(
              `Field '${field.name}' is ${bytes.length} bytes. ` +
              `Maximum is 65535 (heap_len is stored as u16).`,
            );
          }

          encoded.set(field.name, bytes);
          totalHeapBytes += bytes.length;
          continue;
        }

        // ── utf8 / json ────────────────────────────────────────────────────

        // For json fields, serialize the value to a JSON string first.
        // JSON.stringify(undefined | function | symbol) returns undefined —
        // treat those as empty (null read-back on the consumer side).
        const value = field.type === 'json'
          ? (rawValue == null ? '' : (JSON.stringify(rawValue) ?? ''))
          : rawValue;

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
          `Record ${i} requires ${totalHeapBytes} total heap bytes across its variable-length ` +
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
      const writeSeq      = Atomics.load(this.ctrl, CTRL_WRITE_SEQ);
      const effectiveCursor = this.computeEffectiveReadCursor();

      if (writeSeq - effectiveCursor + needed <= capacity) return;

      // Check the abort flag before sleeping.
      if (Atomics.load(this.ctrl, CTRL_ABORT) !== 0) {
        throw new StrandAbortError(
          'Strand stream aborted: the consumer called signalAbort() while the ' +
          'producer was stalled on a full index ring. ' +
          'Catch StrandAbortError in the Worker and call writer.abort() to ' +
          'mark the stream as errored before exiting.',
        );
      }

      // Ring is full. Sleep up to 200 ms for any consumer to advance.
      // All acknowledgeRead() calls (tokenless or with token) fire
      // Atomics.notify on CTRL_READ_CURSOR, so we always wake promptly.
      const legacyCursor = Atomics.load(this.ctrl, CTRL_READ_CURSOR);
      Atomics.wait(this.ctrl, CTRL_READ_CURSOR, legacyCursor, 200);
      // On return ('ok', 'not-equal', or 'timed-out'), loop and re-check.
    }
  }

  /**
   * Effective read cursor for backpressure:
   *   multi-consumer mode (any slot registered): min of all registered slots.
   *   single-consumer / legacy mode: CTRL_READ_CURSOR.
   */
  private computeEffectiveReadCursor(): number {
    let min = -1;
    for (let i = 0; i < MAX_CONSUMERS; i++) {
      const v = Atomics.load(this.ctrl, CTRL_CONSUMER_BASE + i);
      if (v !== CONSUMER_SLOT_VACANT) {
        min = min < 0 ? v : Math.min(min, v);
      }
    }
    return min >= 0 ? min : Atomics.load(this.ctrl, CTRL_READ_CURSOR);
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

    // ── Null validity bitmap ────────────────────────────────────────────────
    //
    // The first bitmapBytes bytes of each slot hold one bit per nullable field.
    // Bit k = 1 → the k-th nullable field was written; 0 → it was omitted (null).
    //
    // Ring slots may be reused (after a ring lap), so we must zero the bitmap
    // before setting bits — stale bits from a previous record must not leak.
    if (this.bitmapBytes > 0) {
      for (let b = 0; b < this.bitmapBytes; b++) {
        this.data.setUint8(recordOffset + b, 0);
      }
      for (const field of this.map.schema.fields) {
        if (
          (field.flags & FIELD_FLAG_NULLABLE) &&
          field.nullableBitIndex !== undefined &&
          record[field.name] !== null &&
          record[field.name] !== undefined
        ) {
          const byteIdx = Math.floor(field.nullableBitIndex / 8);
          const bit     = 1 << (field.nullableBitIndex % 8);
          this.data.setUint8(
            recordOffset + byteIdx,
            this.data.getUint8(recordOffset + byteIdx) | bit,
          );
        }
      }
    }

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

        case 'utf8':
        case 'json': {
          // json fields are pre-serialized to UTF-8 JSON text in encodeHeapFields().
          // The wire format is identical to utf8: [heap_offset: u32][heap_len: u16].
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

        case 'bytes':
        case 'i32_array':
        case 'f32_array': {
          // Wire format identical to utf8: [heap_offset: u32][heap_len: u16].
          // heap_len stores BYTE length (not element count).
          // bytes is 1-byte aligned; i32_array and f32_array require 4-byte alignment.
          const encoded   = heapFields.get(field.name) ?? new Uint8Array(0);
          const alignment = field.type === 'bytes' ? 1 : 4;
          const { heapOffset, physOffset } = this.claimHeap(encoded.length, alignment);

          if (encoded.length > 0) {
            new Uint8Array(this.sab, this.heapStartByte + physOffset, encoded.length)
              .set(encoded);
          }

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
  private claimHeap(
    byteLen:   number,
    alignment: number = 1,
  ): { heapOffset: number; physOffset: number } {
    // Load current monotonic cursor. For single-producer this Atomics.load
    // is equivalent to a plain read, but the Atomics API is used throughout
    // for correctness and to prevent compiler re-ordering.
    //
    // CTRL_HEAP_WRITE is stored in an Int32Array. After accumulating more than
    // 2^31 bytes of heap writes, Atomics.load returns a negative signed value.
    // The >>> 0 coercion reinterprets the bit pattern as an unsigned 32-bit
    // integer, giving the correct monotonic position. The consumer reads the
    // heap_offset field via getUint32 (unsigned), so both sides are consistent.
    let heapWrite  = Atomics.load(this.ctrl, CTRL_HEAP_WRITE) >>> 0;
    let physCursor = heapWrite % this.map.heap_capacity;

    if (byteLen === 0) {
      // Empty: no heap bytes needed. Store the current cursor as the
      // offset (heap_len = 0 means the consumer reads zero bytes from here).
      return { heapOffset: heapWrite, physOffset: physCursor };
    }

    // ── Alignment padding ─────────────────────────────────────────────────
    //
    // Float32Array and Int32Array require their SAB byte offset to be a
    // multiple of their element size (4 bytes). physCursor + heapStartByte
    // is always 4-byte aligned when physCursor = 0 (heapStart is divisible
    // by 4: HEADER_SIZE=512 + index_capacity × record_stride, both multiples
    // of 4). We must ensure physCursor itself is a multiple of alignment.
    //
    // utf8, json, and bytes pass alignment = 1, so this block is a no-op.

    if (alignment > 1) {
      const misalign = physCursor % alignment;

      if (misalign !== 0) {
        const pad             = alignment - misalign;
        const bytesBeforeWrap = this.map.heap_capacity - physCursor;

        if (pad <= bytesBeforeWrap) {
          // Padding fits entirely before the ring boundary.
          // Advance the cursor by pad bytes; no data is written here.
          Atomics.add(this.ctrl, CTRL_HEAP_WRITE, pad);
          heapWrite  += pad;
          physCursor += pad;
        } else {
          // The aligned position is past the ring boundary. Wrap now.
          // physOffset = 0 is always aligned for any power-of-2 alignment.
          if (bytesBeforeWrap >= HEAP_SKIP_SIZE) {
            const sentinelView = new DataView(
              this.sab,
              this.heapStartByte + physCursor,
              HEAP_SKIP_SIZE,
            );
            sentinelView.setUint16(0, HEAP_SKIP_MAGIC,                     true);
            sentinelView.setUint32(2, bytesBeforeWrap - HEAP_SKIP_SIZE,    true);
          }
          Atomics.add(this.ctrl, CTRL_HEAP_WRITE, bytesBeforeWrap);
          heapWrite  += bytesBeforeWrap;
          physCursor  = 0;
        }
      }
    }

    // ── Data bytes ────────────────────────────────────────────────────────

    const bytesBeforeWrap = this.map.heap_capacity - physCursor;

    if (byteLen <= bytesBeforeWrap) {
      // ── Happy path: data fits before the ring boundary ───────────────────
      Atomics.add(this.ctrl, CTRL_HEAP_WRITE, byteLen);
      return { heapOffset: heapWrite, physOffset: physCursor };
    }

    // ── Wrap path: data does not fit before the ring boundary ─────────────
    //
    // We cannot split a typed-array across the ring boundary — the consumer
    // requires a contiguous subarray for a zero-copy typed-array view.
    // Instead:
    //   1. Write a skip sentinel at the current position (if space allows).
    //   2. Skip HEAP_WRITE forward to the ring origin (physOffset = 0).
    //   3. The data is written at physOffset = 0 (always aligned).

    if (bytesBeforeWrap >= HEAP_SKIP_SIZE) {
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

    // The data's monotonic heap_offset is the position AFTER the pre-wrap
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
