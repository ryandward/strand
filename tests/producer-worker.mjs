/**
 * Producer worker for @strand/core stress tests.
 *
 * Spawned by stress.test.ts via worker_threads.Worker.
 * Imports from ../dist/index.js — run `npm run build` (or `npm test`, which
 * runs the pretest build step) before running tests.
 *
 * workerData:
 *   sab          SharedArrayBuffer — already initialised with a Strand header
 *   totalRecords number            — total records to write
 *   batchSize    number            — records per writeRecordBatch call
 *
 * Posts { status: 'done' } to parentPort when all records are written and
 * the stream is finalized.
 */
import { parentPort, workerData } from 'worker_threads';
import { StrandWriter } from '../dist/index.js';

const { sab, totalRecords, batchSize } = workerData;

const writer = new StrandWriter(sab);
writer.begin();

for (let i = 0; i < totalRecords; i += batchSize) {
  const end   = Math.min(i + batchSize, totalRecords);
  const batch = [];
  for (let j = i; j < end; j++) {
    batch.push({ id: j });
  }
  // Blocks the worker thread via Atomics.wait when the index ring is full.
  // The main test thread advances READ_CURSOR via view.acknowledgeRead(),
  // which fires Atomics.notify and wakes this wait.
  writer.writeRecordBatch(batch);
}

writer.finalize();
parentPort.postMessage({ status: 'done' });
