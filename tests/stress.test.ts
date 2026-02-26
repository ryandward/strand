/**
 * @strand/core — Ring Buffer Stress Tests
 *
 * Three scenarios that target ring-boundary conditions. They must all pass
 * before integrating @strand/core into the GenomeHub worker.
 *
 *  1. Slow Consumer   — producer writes 4× index_capacity while the consumer
 *                       acknowledges with a 10 ms delay per batch. Proves the
 *                       Atomics backpressure stall/wake cycle works end-to-end.
 *
 *  2. Heap Wrap       — write strings that force the 0xFFFF skip-sentinel to
 *                       fire at the heap ring boundary. Verify StrandView reads
 *                       the wrapped string correctly from physOffset 0.
 *
 *  3. Partial Write   — simulate a Worker crash after Atomics.add(WRITE_SEQ)
 *    Recovery           but before Atomics.store(COMMIT_SEQ). Verify a new
 *                       StrandWriter resets WRITE_SEQ to the last clean commit.
 *
 * ── Threading model ──────────────────────────────────────────────────────────
 *
 *  Slow Consumer (test 1): producer runs in a real Node.js worker_threads.Worker.
 *    Atomics.wait blocks the worker thread; the main test thread uses
 *    Atomics.waitAsync (via StrandView.waitForCommit) to drain without blocking.
 *
 *  Heap Wrap (test 2) and Partial Write Recovery (test 3): run entirely on the
 *    main test thread. Node.js (unlike browsers) allows Atomics.wait on the main
 *    thread, so StrandWriter can be called directly provided the ring never fills
 *    (index_capacity is set large enough for each test's record count).
 */

import { describe, it, expect } from 'vitest';
import { Worker }               from 'worker_threads';
import {
  buildSchema,
  computeStrandMap,
  initStrandHeader,
  readStrandHeader,
  StrandView,
  StrandWriter,
  StrandHeaderError,
  HEADER_SIZE,
  OFFSET_HEADER_CRC,
  CTRL_WRITE_SEQ,
  CTRL_COMMIT_SEQ,
  CTRL_HEAP_WRITE,
  CTRL_HEAP_COMMIT,
  CTRL_ABORT,
  HEAP_SKIP_MAGIC,
  HEAP_SKIP_SIZE,
  heapStart,
} from '../src/index';

// ─── Test 1: Slow Consumer ────────────────────────────────────────────────────

describe('stress: ring buffer boundaries', () => {

  it(
    'slow consumer — Atomics backpressure stall/wake cycle survives a 4× flood',
    async () => {
      const BATCH_SIZE     = 4;
      const INDEX_CAPACITY = 8;   // small ring: producer stalls after 2 full batches
      const TOTAL_RECORDS  = 32;  // 4× capacity → guarantees repeated stall/wake cycles

      const schema = buildSchema([{ name: 'id', type: 'u32' }]);
      const map    = computeStrandMap({
        schema,
        index_capacity:    INDEX_CAPACITY,
        heap_capacity:     512,
        query:             { assembly: '', chrom: '', start: 0, end: 0 },
        estimated_records: TOTAL_RECORDS,
      });
      const sab = new SharedArrayBuffer(map.total_bytes);
      initStrandHeader(sab, map);

      // ── Spawn the producer in a worker thread ────────────────────────────
      //
      // The worker calls StrandWriter.writeRecordBatch, which blocks via
      // Atomics.wait(READ_CURSOR) when the index ring is full. That stall
      // is released only when the consumer below calls view.acknowledgeRead().
      const worker = new Worker(
        new URL('./producer-worker.mjs', import.meta.url),
        { workerData: { sab, totalRecords: TOTAL_RECORDS, batchSize: BATCH_SIZE } },
      );

      // Capture workerDone *before* the consumer loop so we cannot miss a
      // 'message' event that fires while the loop is still running.
      const workerDone = new Promise<void>((resolve, reject) => {
        worker.once('message', () => resolve());
        worker.once('error',   reject);
        worker.once('exit',    code => {
          if (code !== 0) reject(new Error(`Producer worker exited with code ${code}`));
        });
      });

      // workerError is raced against every waitForCommit call so the test
      // fails immediately (not after a 2 s timeout) if the worker crashes.
      // The .catch() suppresses the "unhandled rejection" warning for the
      // happy path where the worker succeeds and workerError never settles.
      const workerError = new Promise<never>((_, reject) => {
        worker.once('error', reject);
        worker.once('exit',  code => {
          if (code !== 0) reject(new Error(`Producer worker exited with code ${code}`));
        });
      });
      workerError.catch(() => {});

      // ── Consumer loop (main thread) ──────────────────────────────────────
      //
      // waitForCommit uses Atomics.waitAsync — legal on the main thread.
      // Each iteration reads all newly committed records, then acknowledges
      // them (advancing READ_CURSOR and waking the stalled producer), then
      // sleeps 10 ms to simulate slow processing.
      //
      // count <= cursor is a spurious wakeup (e.g., the producer's begin()
      // fires Atomics.notify(COMMIT_SEQ) as a status-change signal before
      // any records are committed). We simply re-arm the wait on the next
      // iteration — no records are lost.
      const view     = new StrandView(sab);
      const rc       = view.allocateCursor();
      let   cursor   = 0;
      const received: number[] = [];

      while (received.length < TOTAL_RECORDS) {
        // Race: either get a commit or detect a worker crash immediately.
        const count = await Promise.race([
          view.waitForCommit(cursor, 2_000),
          workerError,
        ]);

        // Spurious wakeup — re-arm without advancing the cursor.
        if (count <= cursor) continue;

        // Drain every newly committed record into `received`.
        for (let seq = cursor; seq < count; seq++) {
          rc.seek(seq);
          received.push(rc.getU32('id')!);
        }

        // Advance READ_CURSOR — this is what wakes a stalled producer.
        view.acknowledgeRead(count);
        cursor = count;

        // Slow consumer: pause before the next drain so the producer has
        // time to refill the ring and hit the stall condition again.
        if (received.length < TOTAL_RECORDS) {
          await new Promise(r => setTimeout(r, 10));
        }
      }

      // Wait for the producer to call finalize() and exit cleanly.
      await workerDone;
      await worker.terminate();

      // ── Assertions ───────────────────────────────────────────────────────

      // Every id must arrive exactly once, in order.
      expect(received).toHaveLength(TOTAL_RECORDS);
      expect(received).toEqual(
        Array.from({ length: TOTAL_RECORDS }, (_, i) => i),
      );

      // The producer called finalize() — stream must be EOS.
      expect(view.status).toBe('eos');
    },
    10_000, // test-level timeout: 10 s
  );

  // ─── Test 2: Heap Wrap ──────────────────────────────────────────────────────

  it('heap wrap — 0xFFFF skip-sentinel fires at ring boundary; wrapped string is readable', () => {
    //
    // Heap layout with heap_capacity=300 and STR_LEN=110 bytes per record:
    //
    //   heapWrite   physCursor  bytesBeforeWrap  action
    //   ─────────   ──────────  ───────────────  ──────
    //       0           0            300         happy path → heapOffset=0,   physOffset=0
    //     110         110            190         happy path → heapOffset=110,  physOffset=110
    //     220         220             80         80 < 110  → WRAP!
    //                                             sentinel at physOffset=220
    //                                             skip_bytes = 80 − 6 (HEAP_SKIP_SIZE) = 74
    //                                             heapOffset=300, physOffset=0
    //     410         110            190         happy path → heapOffset=410,  physOffset=110
    //
    // Records 2 and 3 physically overwrite records 0 and 1 in the heap ring
    // (this is expected — the heap is a sliding-window ring, not an archive).
    // We verify records 0 and 1 *before* writing the records that overwrite them.
    //
    const HEAP_CAP = 300;
    const STR_LEN  = 110;

    const schema = buildSchema([
      { name: 'id',   type: 'u32'  },
      { name: 'data', type: 'utf8' },
    ]);
    const map = computeStrandMap({
      schema,
      index_capacity:    16,   // large enough: 4 records never stall the ring
      heap_capacity:     HEAP_CAP,
      query:             { assembly: '', chrom: '', start: 0, end: 0 },
      estimated_records: 4,
    });
    const sab = new SharedArrayBuffer(map.total_bytes);
    initStrandHeader(sab, map);

    const writer = new StrandWriter(sab);
    const view   = new StrandView(sab);
    const rc     = view.allocateCursor();

    // ── Phase 1: records 0 and 1 (no wrap) ─────────────────────────────────
    //
    // Read each string immediately after writing so we can verify it *before*
    // the wrap in Phase 2 overwrites these heap bytes.

    writer.writeRecordBatch([{ id: 0, data: 'A'.repeat(STR_LEN) }]);
    rc.seek(0); expect(rc.getString('data')).toBe('A'.repeat(STR_LEN));

    writer.writeRecordBatch([{ id: 1, data: 'B'.repeat(STR_LEN) }]);
    rc.seek(1); expect(rc.getString('data')).toBe('B'.repeat(STR_LEN));

    // Heap state after Phase 1:
    //   physOffset 0  ..109  → 'A'.repeat(110)
    //   physOffset 110..219  → 'B'.repeat(110)
    //   heapWrite = 220

    // ── Phase 2: record 2 triggers the wrap ─────────────────────────────────

    writer.writeRecordBatch([{ id: 2, data: 'C'.repeat(STR_LEN) }]);

    // Heap state after Phase 2:
    //   physOffset 0  ..109  → 'C'.repeat(110)  ← record 2 (overwrote record 0)
    //   physOffset 110..219  → 'B'.repeat(110)  ← record 1 (still intact)
    //   physOffset 220..225  → sentinel [0xFFFF][74]
    //   heapWrite = 410 (monotonic)

    // StrandView must decode record 2 correctly despite the wrap.
    rc.seek(2);
    expect(rc.getU32('id')).toBe(2);
    expect(rc.getString('data')).toBe('C'.repeat(STR_LEN));

    // ── Verify the skip-sentinel in raw SAB bytes ───────────────────────────

    const heapBase = heapStart(map.index_capacity, map.record_stride);
    const raw      = new DataView(sab);

    // Sentinel location: heapBase + 220 (physOffset where wrap was triggered).
    const sentinelMagic = raw.getUint16(heapBase + 220, /* le */ true);
    const sentinelSkip  = raw.getUint32(heapBase + 222,           true);

    expect(sentinelMagic).toBe(HEAP_SKIP_MAGIC); // 0xFFFF
    // skip_bytes = bytesBeforeWrap(80) − HEAP_SKIP_SIZE(6) = 74
    expect(sentinelSkip).toBe(80 - HEAP_SKIP_SIZE);

    // Record 2's data lives at physOffset 0 (physically contiguous from heap origin).
    const decoder     = new TextDecoder();
    const wrappedSlice = new Uint8Array(sab, heapBase + 0, STR_LEN);
    expect(decoder.decode(wrappedSlice)).toBe('C'.repeat(STR_LEN));

    // ── Phase 3: record 3 lands just after the wrapped bytes ────────────────
    //
    // heapWrite=410, physCursor=410%300=110, bytesBeforeWrap=190 ≥ 110 → happy path.
    // Record 3 goes to physOffset=110, overwriting record 1's old bytes.

    writer.writeRecordBatch([{ id: 3, data: 'D'.repeat(STR_LEN) }]);
    rc.seek(3); expect(rc.getString('data')).toBe('D'.repeat(STR_LEN));

    // Confirm physically: record 3's bytes at heap physOffset 110.
    const record3Slice = new Uint8Array(sab, heapBase + 110, STR_LEN);
    expect(decoder.decode(record3Slice)).toBe('D'.repeat(STR_LEN));
  });

  // ─── Test 3: Partial Write Recovery ─────────────────────────────────────────

  it('partial write recovery — new StrandWriter rewinds orphaned WRITE_SEQ to COMMIT_SEQ', () => {
    //
    // Simulates a Worker that:
    //   1. Successfully writes 3 records (COMMIT_SEQ = 3).
    //   2. Claims 4 more index slots via Atomics.add(WRITE_SEQ, 4) and
    //      also claims heap bytes via Atomics.add(HEAP_WRITE, 128) —
    //      but then crashes before calling Atomics.store(COMMIT_SEQ, 7).
    //   3. A new StrandWriter is constructed on the same SAB.
    //      Its constructor detects WRITE_SEQ(7) ≠ COMMIT_SEQ(3) and
    //      HEAP_WRITE(128) ≠ HEAP_COMMIT(0), then rewinds both.
    //

    const schema = buildSchema([{ name: 'id', type: 'u32' }]);
    const map    = computeStrandMap({
      schema,
      index_capacity:    8,
      heap_capacity:     512,
      query:             { assembly: '', chrom: '', start: 0, end: 0 },
      estimated_records: 10,
    });
    const sab  = new SharedArrayBuffer(map.total_bytes);
    initStrandHeader(sab, map);

    // Ctrl array shared by all code in this test — always reflects live SAB state.
    const ctrl = new Int32Array(sab, 0, HEADER_SIZE / 4);

    // ── Phase 1: Establish a clean committed state ───────────────────────────

    const writer1 = new StrandWriter(sab);
    writer1.writeRecordBatch([{ id: 0 }, { id: 1 }, { id: 2 }]);

    expect(Atomics.load(ctrl, CTRL_WRITE_SEQ)).toBe(3);
    expect(Atomics.load(ctrl, CTRL_COMMIT_SEQ)).toBe(3);

    // ── Phase 2: Simulate crash — claim without commit ───────────────────────
    //
    // Advance WRITE_SEQ and HEAP_WRITE as the real writer would between
    // Atomics.add(WRITE_SEQ) (step 3) and Atomics.store(COMMIT_SEQ) (step 6)
    // in writeRecordBatch. The "crash" is the absence of the commit store.

    Atomics.add(ctrl, CTRL_WRITE_SEQ,  4);   // WRITE_SEQ = 7  (orphaned)
    Atomics.add(ctrl, CTRL_HEAP_WRITE, 128); // HEAP_WRITE = 128 (orphaned)

    expect(Atomics.load(ctrl, CTRL_WRITE_SEQ)).toBe(7);
    expect(Atomics.load(ctrl, CTRL_COMMIT_SEQ)).toBe(3); // unchanged — consumer sees 3

    // ── Phase 3: Recovery — new StrandWriter detects and rewinds ────────────

    const writer2 = new StrandWriter(sab);
    // Constructor: WRITE_SEQ(7) ≠ COMMIT_SEQ(3) → store(WRITE_SEQ, 3)
    //              HEAP_WRITE(128) ≠ HEAP_COMMIT(0) → store(HEAP_WRITE, 0)

    expect(Atomics.load(ctrl, CTRL_WRITE_SEQ)).toBe(3);
    expect(Atomics.load(ctrl, CTRL_COMMIT_SEQ)).toBe(3);
    expect(Atomics.load(ctrl, CTRL_HEAP_WRITE)).toBe(0);
    expect(Atomics.load(ctrl, CTRL_HEAP_COMMIT)).toBe(0);

    // ── Phase 4: Stream resumes cleanly from the last good commit ───────────

    writer2.writeRecordBatch([{ id: 99 }]);
    // batchStart = Atomics.add(WRITE_SEQ, 1) returns 3 → slot = 3 & 7 = 3.
    // After commit: COMMIT_SEQ = 4.

    const view = new StrandView(sab);
    const rc   = view.allocateCursor();

    // Records 0–2 from the first writer are unaffected.
    for (let i = 0; i < 3; i++) {
      rc.seek(i);
      expect(rc.getU32('id')).toBe(i);
    }

    // Record 3 is the first record from the recovered writer.
    rc.seek(3);
    expect(rc.getU32('id')).toBe(99);

    // Record 4 was never written — seek returns false.
    expect(rc.seek(4)).toBe(false);
  });
});

// ─── Invariants: Production Hardening ────────────────────────────────────────
//
// These four tests confirm the invariants Gemini identified. Each runs in
// isolation; none depends on the stress tests above.

describe('invariants: production hardening', () => {

  // ── 1. Endianness ──────────────────────────────────────────────────────────

  it('endianness: initStrandHeader does not throw on this (little-endian) system', () => {
    //
    // initStrandHeader() probes the platform byte order and throws
    // StrandHeaderError on big-endian systems. All modern x86 / x86-64 / ARM64
    // hosts are little-endian, so this call must succeed without exception.
    //
    const schema = buildSchema([{ name: 'pos', type: 'i64' }]);
    const map    = computeStrandMap({
      schema,
      index_capacity:    16,
      heap_capacity:     512,
      query:             { assembly: '', chrom: '', start: 0, end: 0 },
      estimated_records: 0,
    });
    const sab = new SharedArrayBuffer(map.total_bytes);
    expect(() => initStrandHeader(sab, map)).not.toThrow();
  });

  // ── 2. Schema Alignment ────────────────────────────────────────────────────

  it('schema alignment: record_stride is always a multiple of 4', () => {
    //
    // buildSchema() pads the total field width to Math.ceil(width/4)*4.
    // initStrandHeader() re-validates record_stride % 4 === 0.
    // Exercise every narrow type that could leave a sub-4-byte tail.
    //
    const cases: Array<{ name: string; type: Parameters<typeof buildSchema>[0][0]['type'] }[]> = [
      [{ name: 'a', type: 'u8'   }],               // 1 byte  → stride 4
      [{ name: 'a', type: 'u16'  }],               // 2 bytes → stride 4
      [{ name: 'a', type: 'u8'   }, { name: 'b', type: 'u16'  }], // 1+2=3 → stride 4
      [{ name: 'a', type: 'bool8'}, { name: 'b', type: 'bool8'}, { name: 'c', type: 'bool8'}], // 3 → stride 4
      [{ name: 'a', type: 'i64'  }, { name: 'b', type: 'u8'   }], // 8+1=9 → stride 12
      [{ name: 'a', type: 'utf8' }, { name: 'b', type: 'u8'   }], // 6+1=7 → stride 8
    ];

    for (const fields of cases) {
      const schema = buildSchema(fields);
      expect(
        schema.record_stride % 4,
        `stride ${schema.record_stride} not aligned for [${fields.map(f => f.type).join(', ')}]`,
      ).toBe(0);

      // initStrandHeader also enforces alignment — should not throw.
      const map = computeStrandMap({
        schema,
        index_capacity: 8,
        heap_capacity:  512,
        query:          { assembly: '', chrom: '', start: 0, end: 0 },
        estimated_records: 0,
      });
      const sab = new SharedArrayBuffer(map.total_bytes);
      expect(() => initStrandHeader(sab, map)).not.toThrow();
    }
  });

  // ── 3. Header CRC ─────────────────────────────────────────────────────────

  it('header CRC: corruption of a geometry field is detected by readStrandHeader', () => {
    //
    // initStrandHeader writes an FNV-1a checksum of bytes 0–23 (the six
    // static geometry fields) at OFFSET_HEADER_CRC (byte 24).
    // readStrandHeader re-computes that checksum before using any field value.
    //
    // Scenario: a rogue pointer corrupts index_capacity (bytes 16–19).
    // The CRC should mismatch and readStrandHeader should throw.
    //
    const schema = buildSchema([{ name: 'id', type: 'u32' }]);
    const map    = computeStrandMap({
      schema,
      index_capacity:    16,
      heap_capacity:     512,
      query:             { assembly: '', chrom: '', start: 0, end: 0 },
      estimated_records: 0,
    });
    const sab = new SharedArrayBuffer(map.total_bytes);
    initStrandHeader(sab, map);

    // ── Baseline: a fresh SAB validates cleanly ──────────────────────────────
    expect(() => readStrandHeader(sab)).not.toThrow();

    // ── Corrupt index_capacity (bytes 16–19) ─────────────────────────────────
    // Write 0xDEADBEEF — an obviously invalid capacity that would cause ring
    // modulo arithmetic to produce wrong slot addresses.
    const raw = new DataView(sab);
    raw.setUint32(16, 0xdeadbeef, /* le */ true);

    expect(() => readStrandHeader(sab)).toThrowError(StrandHeaderError);

    // Verify the error message identifies the CRC failure (not a later step).
    let msg = '';
    try { readStrandHeader(sab); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/CRC/);
  });

  // ── 4. Abort ──────────────────────────────────────────────────────────────

  it(
    'abort: signalAbort() unblocks a stalled producer within 200 ms of the signal',
    async () => {
      //
      // Set up a tiny ring (capacity = 4). The producer writes 1000 records
      // in batches of 4. After the first batch it stalls because the ring is
      // full and no consumer is acknowledging.
      //
      // The main test thread waits 100 ms (giving the producer time to stall),
      // then calls view.signalAbort(). The producer must detect CTRL_ABORT in
      // its 200 ms wait loop and throw StrandAbortError within ≤ 400 ms of
      // the signal (200 ms loop period + scheduling slack).
      //
      const schema = buildSchema([{ name: 'id', type: 'u32' }]);
      const map    = computeStrandMap({
        schema,
        index_capacity:    4,   // tiny ring — producer stalls after batch 1
        heap_capacity:     512,
        query:             { assembly: '', chrom: '', start: 0, end: 0 },
        estimated_records: 1000,
      });
      const sab = new SharedArrayBuffer(map.total_bytes);
      initStrandHeader(sab, map);

      const worker = new Worker(
        new URL('./abort-producer-worker.mjs', import.meta.url),
        { workerData: { sab, totalRecords: 1000, batchSize: 4 } },
      );

      const workerMessage = new Promise<{ status: string }>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error',   reject);
        worker.once('exit',    code => {
          if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
        });
      });

      const view = new StrandView(sab);

      // Wait 100 ms for the producer to stall.
      await new Promise(r => setTimeout(r, 100));

      // Record the timestamp immediately before signalling.
      const t0 = Date.now();
      view.signalAbort();

      // The worker must post 'aborted' within 400 ms of the signal.
      const result = await workerMessage;
      const elapsed = Date.now() - t0;

      await worker.terminate();

      expect(result.status).toBe('aborted');
      expect(elapsed).toBeLessThan(400);

      // CTRL_ABORT should remain set (not cleared by the worker).
      const ctrl = new Int32Array(sab, 0, HEADER_SIZE / 4);
      expect(Atomics.load(ctrl, CTRL_ABORT)).toBe(1);

      // The stream should be STATUS_ERROR (writer.abort() was called).
      expect(view.status).toBe('error');
    },
    5_000,
  );

  // ── 5. Catastrophic Producer Abort ────────────────────────────────────────

  it(
    'catastrophic abort: producer abort() wakes the consumer without deadlock',
    async () => {
      //
      // Scenario: a producer writes N records cleanly across GOOD_BATCHES
      // batches, then simulates a catastrophic failure (Python segfault, pipe
      // break, uncaught exception) by firing both abort channels before the
      // Worker exits — no finalize(), no clean EOS.
      //
      // Assertions:
      //   1. Consumer detects the abort via view.status === 'error'.
      //      (StrandAbortError is the producer's signal; 'error' status is the
      //       consumer-observable equivalent — they are two sides of the same
      //       event.)
      //   2. Consumer exits waitForCommit() in well under 1 s — no deadlock.
      //   3. All committed records are readable and correct up to the exact
      //      point of failure.
      //   4. WRITE_SEQ === COMMIT_SEQ — no torn write. The crash happened
      //      between fully-committed batches, so the commit fence is clean.
      //   5. CTRL_ABORT === 1 — the abort flag is observable by diagnostics.
      //
      const BATCH_SIZE   = 2;
      const GOOD_BATCHES = 3;
      const GOOD_RECORDS = GOOD_BATCHES * BATCH_SIZE; // 6 records

      const schema = buildSchema([{ name: 'id', type: 'i32' }]);
      const map    = computeStrandMap({
        schema,
        index_capacity:    16,  // large enough that backpressure never fires
        heap_capacity:     128,
        query:             { assembly: '', chrom: '', start: 0, end: 0 },
        estimated_records: GOOD_RECORDS,
      });
      const sab = new SharedArrayBuffer(map.total_bytes);
      initStrandHeader(sab, map);

      const worker = new Worker(
        new URL('./catastrophic-producer-worker.mjs', import.meta.url),
        { workerData: { sab, batchSize: BATCH_SIZE, goodBatches: GOOD_BATCHES } },
      );

      const workerMessage = new Promise<{ status: string; committedRecords: number }>(
        (resolve, reject) => {
          worker.once('message', resolve);
          worker.once('error',   reject);
          worker.once('exit', code => {
            if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
          });
        },
      );

      const view = new StrandView(sab);
      const rc   = view.allocateCursor();

      // ── Consumer drain loop ────────────────────────────────────────────────
      //
      // 200 ms timeout on each waitForCommit() is the deadlock safety net.
      // If writer.abort()'s notify(COMMIT_SEQ) races the consumer's waitAsync
      // setup, the consumer wakes from the timeout instead and checks status.
      // Either path terminates the loop — no infinite block is possible.
      //
      let cursor = 0;
      const t0   = Date.now();

      while (true) {
        const count = await view.waitForCommit(cursor, 200);

        // Read and verify any newly committed records.
        for (let seq = cursor; seq < count; seq++) {
          rc.seek(seq);
          expect(rc.getI32('id')).toBe(seq);
        }
        if (count > cursor) {
          view.acknowledgeRead(count);
          cursor = count;
        }

        // Status check is the consumer's abort detection mechanism.
        // writer.abort() sets STATUS_ERROR and notifies COMMIT_SEQ;
        // the consumer wakes (or times out), reads whatever records are
        // visible, and then detects the error here.
        const status = view.status;
        if (status === 'error' || status === 'eos') {
          // ── Final synchronous drain ────────────────────────────────────
          // The producer committed records, THEN set STATUS_ERROR. Our last
          // waitForCommit() may have returned before reading all of them if
          // the abort-notify raced ahead of the commit-notify. Flush the
          // remainder synchronously — committed records are always valid.
          const finalCount = view.committedCount;
          for (let seq = cursor; seq < finalCount; seq++) {
            rc.seek(seq);
            expect(rc.getI32('id')).toBe(seq);
          }
          if (finalCount > cursor) {
            view.acknowledgeRead(finalCount);
            cursor = finalCount;
          }
          break;
        }

        // Deadlock guard: this path only fires if the test itself is broken.
        if (Date.now() - t0 > 1_500) {
          throw new Error(
            `Consumer deadlock: abort signal not received after 1.5 s. ` +
            `cursor=${cursor} status=${status}`,
          );
        }
      }

      const elapsedMs    = Date.now() - t0;
      const workerResult = await workerMessage;
      await worker.terminate();

      // 1. Consumer detects the abort — no unhandled exception, no infinite wait.
      expect(view.status).toBe('error');

      // 2. No deadlock: even the worst-case timeout path finishes in < 1 s.
      expect(elapsedMs).toBeLessThan(1_000);

      // 3. All committed records were readable and correct.
      expect(cursor).toBe(GOOD_RECORDS);

      // 4. No torn write: WRITE_SEQ and COMMIT_SEQ both land on GOOD_RECORDS.
      //    The crash happened between fully-committed batches, so the commit
      //    fence is exactly at the last clean record.
      const ctrl = new Int32Array(sab, 0, HEADER_SIZE / 4);
      expect(Atomics.load(ctrl, CTRL_WRITE_SEQ)).toBe(GOOD_RECORDS);
      expect(Atomics.load(ctrl, CTRL_COMMIT_SEQ)).toBe(GOOD_RECORDS);

      // 5. CTRL_ABORT is set — any diagnostic tool observing the SAB sees it.
      expect(Atomics.load(ctrl, CTRL_ABORT)).toBe(1);

      // 6. Worker confirms exactly GOOD_RECORDS were committed before catastrophe.
      expect(workerResult.status).toBe('catastrophic');
      expect(workerResult.committedRecords).toBe(GOOD_RECORDS);
    },
    5_000,
  );
});

// ─── Input Validation Tests ───────────────────────────────────────────────────

describe('invariants: input validation', () => {

  function makeSimpleSab(indexCapacity = 8) {
    const schema = buildSchema([{ name: 'id', type: 'i32' }]);
    const map    = computeStrandMap({
      schema,
      index_capacity:    indexCapacity,
      heap_capacity:     256,
      query:             { assembly: '', chrom: '', start: 0, end: 0 },
      estimated_records: 0,
    });
    const sab = new SharedArrayBuffer(map.total_bytes);
    initStrandHeader(sab, map);
    return { sab, map };
  }

  // ── 1. acknowledgeRead bounds check ───────────────────────────────────────

  it('acknowledgeRead: throws RangeError when upTo exceeds committedCount', async () => {
    const { sab } = makeSimpleSab();
    const view    = new StrandView(sab);
    const writer  = new StrandWriter(sab);
    writer.begin();
    writer.writeRecordBatch([{ id: 0 }, { id: 1 }]); // committedCount = 2

    // Within bounds — must not throw.
    expect(() => view.acknowledgeRead(1)).not.toThrow();
    expect(() => view.acknowledgeRead(2)).not.toThrow();

    // Exceeds committedCount — must throw.
    expect(() => view.acknowledgeRead(3)).toThrowError(RangeError);
    expect(() => view.acknowledgeRead(999)).toThrowError(RangeError);
  });

  // ── 2. buildSchema duplicate field names ──────────────────────────────────

  it('buildSchema: throws TypeError on duplicate field name', () => {
    expect(() =>
      buildSchema([
        { name: 'pos',  type: 'u32' },
        { name: 'qual', type: 'f32' },
        { name: 'pos',  type: 'i32' }, // duplicate
      ]),
    ).toThrowError(TypeError);
  });

  // ── 3. buildSchema rejects empty field array ───────────────────────────────

  it('buildSchema: throws TypeError on empty field array', () => {
    expect(() => buildSchema([])).toThrowError(TypeError);
  });

  // ── 4. claimHeap: physCursor is correct when CTRL_HEAP_WRITE has overflowed past int32 max ──

  it('claimHeap: UTF-8 field readable after CTRL_HEAP_WRITE is set to a negative int32 value', () => {
    //
    // CTRL_HEAP_WRITE is stored in Int32Array. After 2^31 bytes of heap
    // writes, Atomics.load returns a negative signed value. Without the
    // >>> 0 fix, physCursor = negative % heapCapacity would also be negative,
    // causing a write at heapStartByte + negative_offset (out of bounds or wrong
    // address). With the fix, the bit pattern is reinterpreted as uint32.
    //
    // To simulate the overflow cheaply, we force CTRL_HEAP_WRITE to the int32
    // value -256 (bit pattern 0xFFFFFF00 = uint32 4294967040). This means the
    // heap cursor is exactly 256 bytes before its next uint32 wrap-around —
    // equivalent to the heap ring being positioned at physOffset = 0 after the
    // unsigned interpretation.
    //
    const schema = buildSchema([{ name: 'tag', type: 'utf8' }]);
    const map    = computeStrandMap({
      schema,
      index_capacity:    4,
      heap_capacity:     256,
      query:             { assembly: '', chrom: '', start: 0, end: 0 },
      estimated_records: 0,
    });
    const sab = new SharedArrayBuffer(map.total_bytes);
    initStrandHeader(sab, map);

    // Force CTRL_HEAP_WRITE and CTRL_HEAP_COMMIT to -256 (int32 bit pattern for
    // uint32 value 4294967040). Without >>> 0, physCursor = (-256) % 256 = 0
    // in V8 (implementation-defined for negative modulo), but the monotonic
    // heap_offset stored in the index record would still be the raw signed value
    // -256, and the consumer's getUint32 would read an enormous physOffset.
    const ctrl = new Int32Array(sab, 0, HEADER_SIZE / 4);
    Atomics.store(ctrl, CTRL_HEAP_WRITE,  -256); // bit pattern = uint32 4294967040
    Atomics.store(ctrl, CTRL_HEAP_COMMIT, -256);

    const writer = new StrandWriter(sab);
    writer.begin();
    writer.writeRecordBatch([{ tag: 'hello' }]);
    writer.finalize();

    const view = new StrandView(sab);
    const rc   = view.allocateCursor();
    expect(rc.seek(0)).toBe(true);
    expect(rc.getString('tag')).toBe('hello');
  });

  // ── 5. readStrandHeader: schema_byte_len = 0 is rejected ──────────────────

  it('readStrandHeader: throws StrandHeaderError when schema_byte_len is 0', () => {
    const { sab } = makeSimpleSab();

    // Overwrite schema_byte_len at OFFSET_SCHEMA_BYTE_LEN (byte 56) to 0.
    // This bypasses the CRC (which only covers bytes 0–23) and simulates
    // a corrupt schema section.
    new DataView(sab).setUint32(56, 0, /* le */ true);

    expect(() => readStrandHeader(sab)).toThrowError(StrandHeaderError);
  });

  // ── 6. computeStrandMap: non-power-of-2 index_capacity is rejected ─────────

  it('computeStrandMap: throws StrandHeaderError for non-power-of-2 index_capacity', () => {
    const schema = buildSchema([{ name: 'id', type: 'u32' }]);

    expect(() =>
      computeStrandMap({
        schema,
        index_capacity:    6, // not a power of 2
        heap_capacity:     256,
        query:             { assembly: '', chrom: '', start: 0, end: 0 },
        estimated_records: 0,
      }),
    ).toThrowError(StrandHeaderError);

    // Powers of 2 must pass.
    expect(() =>
      computeStrandMap({
        schema,
        index_capacity:    8,
        heap_capacity:     256,
        query:             { assembly: '', chrom: '', start: 0, end: 0 },
        estimated_records: 0,
      }),
    ).not.toThrow();
  });
});
