/**
 * Catastrophic producer worker for @strand/core abort survival tests.
 *
 * Writes goodBatches × batchSize records cleanly (every batch fully committed
 * with WRITE_SEQ === COMMIT_SEQ after each one), then simulates a catastrophic
 * mid-stream failure without ever calling finalize().
 *
 * Catastrophe sequence:
 *   1. view.signalAbort()  — CTRL_ABORT = 1; Atomics.notify(READ_CURSOR, 1)
 *   2. writer.abort()      — STATUS_ERROR;   Atomics.notify(COMMIT_SEQ, 1)
 *
 * Both abort channels fire simultaneously. This mirrors what a SIGTERM handler
 * or an uncaught-exception boundary would do in a production GenomeHub worker:
 *   • notify(COMMIT_SEQ) wakes any consumer blocked in waitForCommit().
 *   • notify(READ_CURSOR) wakes any producer stalled in waitForIndexSpace()
 *     (no-op here since there is no backpressure, but correct for parity).
 *
 * After this, the buffer invariants hold:
 *   - view.status === 'error'   (consumer's abort detection via status)
 *   - CTRL_ABORT === 1          (abort flag observable by diagnostics)
 *   - WRITE_SEQ === COMMIT_SEQ  (no torn write — crash occurred between batches)
 *
 * workerData:
 *   sab         SharedArrayBuffer — initialized with a Strand header
 *   batchSize   number            — records per writeRecordBatch call
 *   goodBatches number            — clean batches to write before catastrophe
 */
import { parentPort, workerData } from 'worker_threads';
import { StrandWriter, StrandView } from '../dist/index.js';

const { sab, batchSize, goodBatches } = workerData;

const writer = new StrandWriter(sab);
writer.begin();

for (let b = 0; b < goodBatches; b++) {
  const batch = [];
  for (let j = 0; j < batchSize; j++) {
    batch.push({ id: b * batchSize + j });
  }
  writer.writeRecordBatch(batch);
}

// ── Catastrophic failure ────────────────────────────────────────────────────
//
// In a real GenomeHub worker this is what happens when Python segfaults or
// the htslib pipe produces garbage: we catch the error, fire both abort
// channels so no thread deadlocks, and exit. The consumer sees status='error'
// on its next waitForCommit() iteration and tears down cleanly.
//
const view = new StrandView(sab);
view.signalAbort();  // CTRL_ABORT = 1 + notify(READ_CURSOR)
writer.abort();      // STATUS_ERROR  + notify(COMMIT_SEQ)

parentPort.postMessage({
  status: 'catastrophic',
  committedRecords: goodBatches * batchSize,
});
