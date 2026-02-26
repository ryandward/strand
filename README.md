<p align="center">
  <img src="logo.svg" alt="Strand" width="400" />
</p>

<p align="center">
  Zero-copy binary data streaming over <code>SharedArrayBuffer</code>.
</p>

<p align="center">
  <a href="https://github.com/ryandward/strand/actions/workflows/ci.yml">
    <img src="https://github.com/ryandward/strand/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://www.npmjs.com/package/@strand/core">
    <img src="https://img.shields.io/npm/v/@strand/core?color=blue" alt="npm" />
  </a>
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178c6" alt="TypeScript" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
</p>

A Worker thread writes typed records into a lock-free ring buffer; the main thread reads them with zero deserialization overhead and zero per-record heap allocation.

---

## How it works

![Architecture diagram](diagram.svg)

**Backpressure** is automatic: if the consumer falls more than `index_capacity` records behind, `writeRecordBatch()` blocks via `Atomics.wait()` until the consumer calls `acknowledgeRead()`.

**Zero allocation**: `RecordCursor.seek(seq)` mutates two fields on a single pre-allocated object. Calling `getString()` decodes UTF-8 from the SAB once per field per record and caches the result — subsequent calls on the same record are free.

---

## Sequence diagram

```
Main thread                        SharedArrayBuffer             Worker thread
     │                                      │                          │
     │  new SharedArrayBuffer(map.total_bytes)                         │
     │  initStrandHeader(sab, map)           │                          │
     │──────────────────────────────────────>│                          │
     │  new StrandView(sab)                  │                          │
     │  allocateCursor()                     │                          │
     │                                       │  new StrandWriter(sab)   │
     │                                       │<─────────────────────────│
     │                                       │  begin()                 │
     │                                       │<─────────────────────────│
     │                                       │                          │
     │  waitForCommit(0) ···waiting···        │  writeRecordBatch([...]) │
     │                                       │<─────────────────────────│
     │                              COMMIT_SEQ += N                     │
     │                              Atomics.notify ──────────────────>  │
     │<── resolves ──────────────────────────│                          │
     │  for seq in 0..N:                     │                          │
     │    cursor.seek(seq)                   │  writeRecordBatch([...]) │
     │    cursor.getU32('x')                 │<─────────────────────────│
     │    cursor.getString('label')          │  (blocks if ring full)   │
     │  acknowledgeRead(N) ─────────────────>│ ── wakes writer ──────>  │
     │                                       │                          │
     │  waitForCommit(N) ···waiting···        │  finalize()              │
     │                              STATUS = EOS                        │
     │<── resolves ──────────────────────────│                          │
     │  view.status === 'eos' → done         │                          │
```

---

## Installation

```bash
npm install @strand/core
```

Requires a runtime with `SharedArrayBuffer` and `Atomics`. In browsers, the serving page must be [cross-origin isolated](#browser-requirements).

---

## Quick start

### 1. Define a schema (shared between producer and consumer)

```typescript
import { buildSchema, computeStrandMap, initStrandHeader } from '@strand/core';

const schema = buildSchema([
  { name: 'id',       type: 'u32'      }, // fixed-width integer
  { name: 'score',    type: 'f32'      }, // fixed-width float
  { name: 'category', type: 'utf8_ref' }, // interned string (u32 handle, low-cardinality)
  { name: 'label',    type: 'utf8'     }, // variable-length string (heap)
  { name: 'meta',     type: 'json'     }, // sparse per-record metadata
]);

const map = computeStrandMap({
  schema,
  index_capacity:    65_536,           // must be a power of 2; ring slots for records
  heap_capacity:     16 * 1024 * 1024, // bytes for variable-length string/json data
  query:             { assembly: 'v1', chrom: 'part-0', start: 0, end: 1_000_000 },
  estimated_records: 50_000,
});

// Create the SAB once on the main thread and pass it to the worker.
const sab = new SharedArrayBuffer(map.total_bytes);
initStrandHeader(sab, map);
```

### 2. Producer (Worker thread)

```typescript
// worker.ts
import { workerData } from 'worker_threads';
import { StrandWriter } from '@strand/core';

const { sab } = workerData;
const writer  = new StrandWriter(sab);

writer.begin();

for await (const batch of fetchData()) {
  // writeRecordBatch blocks on backpressure; throws StrandAbortError on cancel.
  // Fetch → write → fetch → write. Do not pre-materialize the entire dataset.
  writer.writeRecordBatch(batch);
}

writer.finalize();
```

### 3. Consumer (main thread)

```typescript
import { StrandView } from '@strand/core';

const categories = ['type-a', 'type-b', 'type-c'];
const view   = new StrandView(sab, categories); // intern table for utf8_ref fields
const cursor = view.allocateCursor();           // allocate once; reuse for every record

let seq = 0;

while (true) {
  const count = await view.waitForCommit(seq, 5_000);

  for (; seq < count; seq++) {
    cursor.seek(seq);                           // zero allocations
    const id       = cursor.getU32('id');
    const score    = cursor.getF32('score');
    const category = cursor.getRef('category'); // resolved from intern table
    const label    = cursor.getString('label'); // decoded + cached per record
    const meta     = cursor.getJson('meta');    // parsed + cached per record
    render(id, score, category, label, meta);
  }

  view.acknowledgeRead(count);                  // unblocks a stalled producer

  if (view.status === 'eos') break;
}
```

### 4. Cancel and restart

```typescript
// Signal the worker to stop the current stream.
view.signalAbort();

// In the worker:
try {
  writer.writeRecordBatch(nextBatch);
} catch (e) {
  if (e instanceof StrandAbortError) {
    writer.abort(); // sets STATUS_ERROR
  }
}

// Reset the ring for a fresh stream (both sides must coordinate this).
writer.reset();
```

### 5. Update intern table at runtime

```typescript
// After a stream restart, the server may send a new category list.
// Call updateInternTable() — all existing cursors observe the change immediately.
view.updateInternTable(['type-a', 'type-b', 'type-c', 'type-d']);
```

---

## Production guidance

### Progress tracking

Track progress against **raw write rate**, not filtered output.

`view.committedCount` increments for every record the producer writes, regardless of whether the consumer renders it. Tie your progress bar to `acknowledgeRead()` calls divided by `map.estimated_records`. Do not filter commits before incrementing the counter — that discards reads the ring still needs to release.

```typescript
for (; seq < count; seq++) {
  cursor.seek(seq);
  if (cursor.getF32('score')! > threshold) {
    render(cursor);
  }
}

// Acknowledge ALL records consumed, not just the rendered subset.
view.acknowledgeRead(count);

// Progress: total committed vs. expected total.
const progress = count / view.map.estimated_records;
```

### Producer must block at the ring

`writeRecordBatch()` blocks the Worker thread when the ring is full. Backpressure only works if the producer **calls `writeRecordBatch()` as it fetches data**, not after pre-materializing everything.

```typescript
// WRONG — allocates the full dataset in memory before any records flow
const all = await fetchAll();
writer.writeRecordBatch(all);

// RIGHT — fetch → write → fetch → write; ring controls the pace
for await (const batch of streamFetch()) {
  writer.writeRecordBatch(batch); // stalls here if consumer is slow
}
```

If the producer materializes everything first, backpressure cannot slow the upstream fetch, heap grows unbounded, and the ring's capacity guarantee is defeated.

---

## API reference

### Schema

| Function | Description |
|----------|-------------|
| `buildSchema(fields)` | Validate fields, compute `byteOffset` for each, pad `record_stride` to 4-byte alignment |
| `computeStrandMap(opts)` | Compute full buffer geometry (`total_bytes`, region offsets) |
| `schemaFingerprint(schema)` | FNV-1a hash of the binary schema; validated on every `StrandView` / `StrandWriter` attach |

### Buffer lifecycle

| Function | Description |
|----------|-------------|
| `initStrandHeader(sab, map)` | Write magic, version, geometry, CRC, and schema into a fresh SAB |
| `readStrandHeader(sab)` | Validate magic → CRC → schema; returns `StrandMap` or throws `StrandHeaderError` |

### Producer — `StrandWriter`

| Method | Description |
|--------|-------------|
| `begin()` | Set `STATUS_STREAMING`; wake the consumer |
| `writeRecordBatch(records)` | Write a batch; blocks via `Atomics.wait` if ring is full; throws `StrandAbortError` on cancel |
| `finalize()` | Set `STATUS_EOS`; notify consumer |
| `abort()` | Set `STATUS_ERROR`; notify consumer |
| `reset()` | Rewind all cursors to zero for a fresh stream; does not touch the static header |

### Consumer — `StrandView`

| Method / property | Description |
|-------------------|-------------|
| `allocateCursor()` | Allocate a `RecordCursor` sharing this view's immutable state |
| `waitForCommit(after, timeoutMs?)` | `Atomics.waitAsync` — resolves when `committedCount > after` |
| `acknowledgeRead(upTo)` | Advance `READ_CURSOR`; unblocks a stalled producer |
| `signalAbort()` | Set `CTRL_ABORT = 1`; wake a stalled producer |
| `updateInternTable(table)` | Replace the `utf8_ref` intern table; all allocated cursors observe the change immediately |
| `committedCount` | `Atomics.load(COMMIT_SEQ)` — records safe to read |
| `status` | `'initializing' \| 'streaming' \| 'eos' \| 'error'` |

### Consumer — `RecordCursor`

| Method | Returns | Description |
|--------|---------|-------------|
| `seek(seq)` | `boolean` | Position cursor on record `seq`; clears caches; `false` if seq is out of range |
| `getU32(name)` | `number \| null` | |
| `getI32(name)` | `number \| null` | |
| `getI64(name)` | `bigint \| null` | |
| `getF32(name)` | `number \| null` | |
| `getF64(name)` | `number \| null` | |
| `getU16(name)` | `number \| null` | |
| `getU8(name)` | `number \| null` | |
| `getBool(name)` | `boolean \| null` | |
| `getString(name)` | `string \| null` | Decode UTF-8 from heap; cached per record |
| `getJson(name)` | `unknown` | Parse JSON from heap; cached per record |
| `getRef(name)` | `string \| null` | Resolve interned `utf8_ref` handle |
| `get(name)` | `number \| bigint \| boolean \| string \| unknown` | Generic accessor |
| `seq` | `number` | Current sequence number; `-1` before first seek |

### Field types

| Type | Width | Use |
|------|-------|-----|
| `u32` | 4 B | Unsigned integers — IDs, counts, positions |
| `i32` | 4 B | Signed integers — offsets, deltas |
| `u16` | 2 B | Small unsigned integers — flags, short counts |
| `u8` | 1 B | Bytes — single-byte enums, small values |
| `bool8` | 1 B | Boolean flags |
| `f32` | 4 B | Single-precision floats — scores, probabilities |
| `f64` | 8 B | Double-precision floats — high-precision values |
| `i64` | 8 B | Large signed integers — timestamps, large offsets |
| `utf8` | 6 B | Variable-length strings — heap pointer + length |
| `utf8_ref` | 4 B | Interned low-cardinality strings (<1 000 distinct values) |
| `json` | 6 B | Sparse per-record metadata — heap pointer + length, lazily parsed |

---

## Browser requirements

`SharedArrayBuffer` requires [cross-origin isolation](https://developer.chrome.com/blog/enabling-shared-array-buffer/). Serve the page with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**Next.js:**
```typescript
// next.config.ts
async headers() {
  return [{ source: '/(.*)', headers: [
    { key: 'Cross-Origin-Opener-Policy',   value: 'same-origin' },
    { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
  ]}];
}
```

**SSR (Node.js):** No restrictions. `SharedArrayBuffer`, `Atomics`, and `TextDecoder` are all available without headers. The writer must still run in a `worker_threads.Worker` to avoid blocking the event loop.

---

## Performance

| Metric | Value |
|--------|-------|
| Heap growth — 100K `seek()` calls | **0.01 MB** |
| Heap growth — 100K `new RecordView()` (old API) | 18.74 MB |
| Allocation reduction | **1,874×** |

The ring buffer is designed for throughput-critical hot paths. Records are committed in batches; the consumer drains asynchronously between renders.

---

## Development

```bash
npm test        # tsup build + vitest run (forks pool, --expose-gc)
npm run typecheck
```

---

## License

MIT
