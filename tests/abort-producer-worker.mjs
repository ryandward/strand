/**
 * Abort-aware producer worker for @strand/core invariant tests.
 *
 * Writes records in batches until the ring fills. When the consumer calls
 * view.signalAbort(), waitForIndexSpace() throws StrandAbortError. This
 * worker catches that, calls writer.abort() to mark the stream as errored,
 * and posts { status: 'aborted' } so the test can assert clean exit.
 *
 * workerData:
 *   sab          SharedArrayBuffer — initialized with a Strand header
 *   totalRecords number            — how many records to attempt writing
 *   batchSize    number            — records per writeRecordBatch call
 */
import { parentPort, workerData } from 'worker_threads';
import { StrandWriter, StrandAbortError } from '../dist/index.js';

const { sab, totalRecords, batchSize } = workerData;

const writer = new StrandWriter(sab);
writer.begin();

try {
  for (let i = 0; i < totalRecords; i += batchSize) {
    const end   = Math.min(i + batchSize, totalRecords);
    const batch = [];
    for (let j = i; j < end; j++) {
      batch.push({ id: j });
    }
    writer.writeRecordBatch(batch);
  }
  writer.finalize();
  parentPort.postMessage({ status: 'done' });
} catch (err) {
  if (err instanceof StrandAbortError) {
    // Consumer called signalAbort() — mark the stream as errored and exit.
    writer.abort();
    parentPort.postMessage({ status: 'aborted' });
  } else {
    throw err; // Unexpected error — propagate to worker 'error' event.
  }
}
