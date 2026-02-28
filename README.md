<p align="center">
  <img src="logo.svg" alt="Strand" width="400" />
</p>

<p align="center">
  <strong>Stream massive datasets to your UI without freezing the page. Yes, really. Nobody had done this.</strong>
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

---

### Wait, nobody solved this?

You'd think that streaming large datasets into a UI, records arriving progressively and rendering as they land while the page stays responsive, would be a solved problem by now. It's not.

Look it up. Every guide on handling large data in the browser recommends the same three things: paginate it (only show one page at a time), virtualize the DOM (only render what's on screen), or use infinite scroll (load more as they scroll down). These are all clever ways of *showing less data so the browser doesn't choke*. None of them solve the actual problem of efficiently moving a large, ongoing stream of data from a background thread into your UI.

Most people assume React solved this. I did too. React is an incredible rendering engine, and once data lands in state it updates the screen faster than anything else out there. But React is a UI library, not data infrastructure. It was built at Facebook for the Facebook problem: small, curated payloads delivered fast. A Twitter timeline is 10 items. A TikTok feed is literally one record at a time. Instagram shows you 4 photos per screen. React is perfect for that world, and that world is what the entire frontend ecosystem optimized for.

But the web wasn't always like this. It used to be normal for a page to contain *everything*. Geocities pages were infinite scrolls of a single person's thoughts. Database frontends dumped real resultsets into the browser. The shift to algorithmically curated feeds didn't solve the large data problem. It just made most people forget it existed. If your app delivers a few cards chosen by an algorithm, you never need to think about data streaming at all.

Some applications still have real data. Genomics pipelines, regulatory databases, financial dashboards, scientific visualization. Hundreds of thousands of records that a human needs to query, scan, and filter. You can't paginate your way out of that. The data is the data and someone has to look at it.

The browser has had the right low-level primitives for years: `SharedArrayBuffer` (threads sharing the same block of memory), `Atomics` (coordination without locks), Web Workers (background threads). But nobody wired them together into something you could actually use. I spent 15 years thinking about this problem, then sat down and built it in 10 days once I realized nobody else was going to.

Strand lets a background thread write records directly into shared memory while your main thread reads them in place. No copying. No serialization. No object-per-record allocation. Records appear the instant they're committed. If the reader falls behind, the writer pauses automatically. If you need to cancel and restart, one call does it. **1,874× fewer memory allocations** than the object-per-record approach.

```
npm install @strand/core
```

---

## See it in action

```typescript
// Background thread: writes records as they stream in
const writer = new StrandWriter(sab);
writer.begin();
for await (const batch of fetchData()) {
  writer.writeRecordBatch(batch); // pauses automatically if the reader is busy
}
writer.finalize();

// Main thread: reads records without any copying or parsing
const view   = new StrandView(sab);
const cursor = view.allocateCursor(); // one cursor, reused for every record

let seq = 0;
while (true) {
  const count = await view.waitForCommit(seq);
  for (; seq < count; seq++) {
    cursor.seek(seq);              // no new objects, just repositions the cursor
    render(
      cursor.getU32('id'),         // reads directly from shared memory
      cursor.getF32('score'),
      cursor.getString('label'),   // decoded once, cached after that
    );
  }
  view.acknowledgeRead(count);     // frees ring space so the writer can continue
  if (view.status === 'eos') break;
}
```

That's the whole pattern. One thread writes, the other reads. If the reader is slow, the writer waits. If you need to start over, call `signalAbort()`. The rest is automatic.

---

## What you get

| | The usual approach | With Strand |
|---|---|---|
| **Data flow** | Fetch everything, then render | Records stream in and render as they arrive |
| **Thread communication** | Data copied between threads on every message | Read directly from shared memory, nothing moves |
| **Per-record cost** | One JS object per record | One reusable cursor for all records |
| **Backpressure** | You build it yourself (or don't) | Built in: the writer waits when the reader is busy |
| **Cancellation** | Terminate the Worker | `signalAbort()` for clean, cooperative shutdown |
| **Memory (100K records)** | ~18.74 MB | **0.01 MB** |

---

## How it works

![Architecture diagram](diagram.svg)

Both threads share a single block of memory (`SharedArrayBuffer`) that holds two regions: a fixed-size ring of record slots, and a heap for variable-length data like strings and JSON. The writer claims slots, fills in fields, and marks them as ready. The reader waits for new records, reads them in place, and signals when it's done so those slots can be reused.

**Backpressure** is automatic: if the reader falls a full lap behind on the ring, the writer pauses until space opens up.

**Zero allocation**: reading a record (`cursor.seek(seq)`) just updates two numbers on a single reusable object. Strings are decoded once and cached. Byte arrays and typed arrays are returned as direct views into shared memory with no copies and no parsing.

```
Main thread                         SharedArrayBuffer             Worker thread
     │                                       │                          │
     │new SharedArrayBuffer(map.total_bytes) |                          │
     │initStrandHeader(sab, map)             │                          │
     │──────────────────────────────────────>│                          │
     │  new StrandView(sab)                  │                          │
     │  allocateCursor()                     │                          │
     │                                       │  new StrandWriter(sab)   │
     │                                       │<─────────────────────────│
     │                                       │  begin()                 │
     │                                       │<─────────────────────────│
     │                                       │                          │
     │  waitForCommit(0) ···waiting···       │  writeRecordBatch([...]) │
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
     │  waitForCommit(N) ···waiting···       │  finalize()              │
     │                              STATUS = EOS                        │
     │<── resolves ──────────────────────────│                          │
     │  view.status === 'eos' → done         │                          │
```

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
// Call updateInternTable() and all existing cursors observe the change immediately.
view.updateInternTable(['type-a', 'type-b', 'type-c', 'type-d']);
```

---

## Production guidance

### `acknowledgeRead()` is required: deadlock warning

`acknowledgeRead(count)` must be called in the drain loop **for every record, including filtered ones**. The ring only advances when the read cursor advances. If you call it only for records that pass a filter, the producer stalls once the ring fills and the consumer deadlocks waiting for more commits.

```typescript
// WRONG: deadlocks when total_hits > index_capacity
let hits = 0;
for (; seq < count; seq++) {
  cursor.seek(seq);
  if (cursor.getF32('score')! > threshold) {
    render(cursor);
    hits++;
  }
}
view.acknowledgeRead(hits); // ← only acknowledges filtered subset

// RIGHT: acknowledges all records regardless of filter
for (; seq < count; seq++) {
  cursor.seek(seq);
  if (cursor.getF32('score')! > threshold) render(cursor);
}
view.acknowledgeRead(count); // ← must equal total consumed, not rendered
```

When running producer and consumer concurrently, connect them with `Promise.all` so a stream error in either propagates correctly:

```typescript
async function drain() {
  let seq = 0;
  while (true) {
    const count = await view.waitForCommit(seq);
    for (; seq < count; seq++) {
      cursor.seek(seq);
      render(cursor);
    }
    view.acknowledgeRead(count); // ← unconditional, every record
    if (view.status === 'eos') break;
  }
}

await Promise.all([streamWorker.run(), drain()]);
```

### Progress tracking

Track progress against **raw write rate**, not filtered output.

`view.committedCount` increments for every record the producer writes, regardless of whether the consumer renders it. Tie your progress bar to `acknowledgeRead()` calls divided by `map.estimated_records`.

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
// WRONG: allocates the full dataset in memory before any records flow
const all = await fetchAll();
writer.writeRecordBatch(all);

// RIGHT: fetch → write → fetch → write; ring controls the pace
for await (const batch of streamFetch()) {
  writer.writeRecordBatch(batch); // stalls here if consumer is slow
}
```

If the producer materializes everything first, backpressure cannot slow the upstream fetch, heap grows unbounded, and the ring's capacity guarantee is defeated.

---

## Vectorized filtering

For hot-path filtering (millions of records, reactive UI), the vectorized pipeline avoids per-record `RecordCursor.seek()` overhead entirely. Three stages:

1. **`getFilterBitset`**: scan the SAB for each predicate, write matching bits into a `Uint32Array`. O(N) per predicate.
2. **`computeIntersection`**: AND all bitsets together. O(N/32), 32 records per CPU instruction.
3. **`getConstrainedRanges`**: walk only the matching bits and compute per-field min/max. O(matches × numericFields).

```typescript
import {
  type FilterPredicate,
  type ConstrainedRanges,
  computeIntersection,
  forEachSet,
} from '@strand/core';

// Stage 1: one bitset per active predicate, each scans the SAB once.
const bsScore  = view.getFilterBitset('score',  { kind: 'between', lo: 0.5,  hi: 1.0 });
const bsChrom  = view.getFilterBitset('chrom',  { kind: 'in', handles: new Set([2, 7]) });
const bsStrand = view.getFilterBitset('strand', { kind: 'eq', value: 0 });

// Stage 2: intersect in O(N/32).
const matches = computeIntersection([bsScore, bsChrom, bsStrand]);

// Stage 3a: derive constrained min/max for every numeric field in the filtered view.
const ranges: ConstrainedRanges = view.getConstrainedRanges(matches);
// ranges.start === { min: 102_400, max: 2_891_003 }
// ranges.score === { min: 0.5,     max: 0.98      }

// Stage 3b: walk matching records for rendering.
const ws = view.windowStart;
const n  = view.committedCount - ws;

forEachSet(matches, n, j => {
  const seq = ws + j;
  cursor.seek(seq);
  render(cursor);
});
```

**`FilterPredicate`** (discriminated union):

| `kind` | Fields | Matches when |
|--------|--------|--------------|
| `between` | `lo: number, hi: number` | `lo ≤ value ≤ hi` (inclusive) |
| `eq` | `value: number` | `field === value` |
| `in` | `handles: ReadonlySet<number>` | intern-table handle is a member of the set |

**Supported field types:** `i32`, `u32`, `f32`, `f64`, `u16`, `u8`, `bool8`, `utf8_ref`.
Heap-indirected types (`utf8`, `json`, `bytes`, `i32_array`, `f32_array`) and `i64` throw `TypeError`.

**Bitset utilities:**

| Function | Description |
|----------|-------------|
| `createBitset(bitCount)` | Allocate a zeroed `Uint32Array` for `bitCount` bits |
| `computeIntersection(bitsets)` | Bitwise AND: returns a new bitset, O(N/32) |
| `popcount(bs, limit?)` | Count set bits, O(N/32) |
| `forEachSet(bs, limit, fn)` | Iterate set bits in ascending order; uses `Math.clz32` for O(1) bit isolation |

All bitsets built in the same call to `getFilterBitset` (same `committedCount` snapshot) are directly compatible with `computeIntersection`. Bit j in any bitset represents `seq = windowStart + j`.

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
| `initStrandHeader(sab, map, meta?)` | Write magic, version, geometry, CRC, schema, and optional metadata into a fresh SAB |
| `readStrandHeader(sab)` | Validate magic → CRC → schema; returns `StrandMap` (with `.meta` if present) or throws `StrandHeaderError` |

### Producer: `StrandWriter`

| Method | Description |
|--------|-------------|
| `begin()` | Set `STATUS_STREAMING`; wake the consumer |
| `writeRecordBatch(records)` | Write a batch; blocks via `Atomics.wait` if ring is full; throws `StrandAbortError` on cancel |
| `finalize()` | Set `STATUS_EOS`; notify consumer |
| `abort()` | Set `STATUS_ERROR`; notify consumer |
| `reset()` | Rewind all cursors to zero for a fresh stream; does not touch the static header |

#### WASM write interface

For producers that hold a direct SAB reference (WASM linear memory, native extensions), a claim/commit protocol bypasses the JS serialization layer entirely:

| Method | Description |
|--------|-------------|
| `claimSlot()` | Block for backpressure, claim one index slot. Returns `{ slotOffset, seq }`: write fields directly at `sab[slotOffset + field.byteOffset]`. |
| `commitSlot(seq)` | Advance `COMMIT_SEQ`; enforces ordering (throws `RangeError` if out-of-order). |
| `claimSlots(n)` | Claim `n` slots in one `Atomics.add`. Returns `ReadonlyArray<{ slotOffset, seq }>`. |
| `commitSlots(fromSeq, n)` | Atomically commit a previously claimed batch. |
| `claimHeapBytes(byteLen)` | Claim heap space for a variable-length field. Returns `{ physOffset, monoOffset }`. |
| `commitHeap()` | Advance `CTRL_HEAP_COMMIT` to match `CTRL_HEAP_WRITE`. Call before `commitSlot`. |

### Consumer: `StrandView`

| Method / property | Description |
|-------------------|-------------|
| `allocateCursor()` | Allocate a `RecordCursor` sharing this view's immutable state |
| `waitForCommit(after, timeoutMs?)` | `Atomics.waitAsync`: resolves when `committedCount > after` |
| `acknowledgeRead(upTo, token?)` | Advance read cursor; unblocks a stalled producer. Pass `token` in multi-consumer mode. |
| `registerConsumer()` | Claim a per-consumer cursor slot (multi-consumer mode). Returns a token. |
| `releaseConsumer(token)` | Release a consumer slot; wakes any stalled producer immediately. |
| `findFirst(field, value)` | Binary-search committed records for the first where `field >= value`. O(log N). Requires `FIELD_FLAG_SORTED_ASC`. |
| `getFilterBitset(field, predicate)` | Scan the active ring window and return a `Uint32Array` bitset: bit j set when `seq = windowStart + j` satisfies the predicate. O(N/32). See [Vectorized filtering](#vectorized-filtering). |
| `getConstrainedRanges(intersectionBitset)` | Walk the set bits and compute per-field min/max for all numeric fields. Returns `ConstrainedRanges`. O(matches × numericFields). |
| `signalAbort()` | Set `CTRL_ABORT = 1`; wake a stalled producer |
| `updateInternTable(table)` | Replace the `utf8_ref` intern table; all allocated cursors observe the change immediately |
| `committedCount` | `Atomics.load(COMMIT_SEQ)`: records safe to read |
| `windowStart` | `Math.max(0, committedCount - indexCapacity)`: inclusive start of the accessible ring window |
| `status` | `'initializing' \| 'streaming' \| 'eos' \| 'error'` |
| `map.meta` | Optional producer metadata parsed from header (v4+). `undefined` if not supplied. |

### Consumer: `RecordCursor`

| Method | Returns | Description |
|--------|---------|-------------|
| `seek(seq)` | `boolean` | Position cursor on record `seq`; clears caches; `false` if out of range |
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
| `getBytes(name)` | `Uint8Array \| null` | Zero-copy view into SAB heap for a `bytes` field |
| `getI32Array(name)` | `Int32Array \| null` | Zero-copy view into SAB heap for an `i32_array` field |
| `getF32Array(name)` | `Float32Array \| null` | Zero-copy view into SAB heap for an `f32_array` field |
| `get(name)` | `number \| bigint \| boolean \| string \| unknown` | Generic accessor |
| `seq` | `number` | Current sequence number; `-1` before first seek |

### Field types

| Type | Index width | Accessor | Use |
|------|-------------|----------|-----|
| `u32` | 4 B | `getU32` | Unsigned integers: IDs, counts, positions |
| `i32` | 4 B | `getI32` | Signed integers: offsets, deltas |
| `u16` | 2 B | `getU16` | Small unsigned integers: flags, short counts |
| `u8` | 1 B | `getU8` | Single-byte enums, small values |
| `bool8` | 1 B | `getBool` | Boolean flags |
| `f32` | 4 B | `getF32` | Single-precision floats: scores, probabilities |
| `f64` | 8 B | `getF64` | Double-precision floats: high-precision values |
| `i64` | 8 B | `getI64` | Large signed integers: timestamps, large offsets |
| `utf8` | 6 B | `getString` | Variable-length strings: heap-backed, decoded on read, cached per record |
| `utf8_ref` | 4 B | `getRef` | Interned low-cardinality strings (<1 000 distinct values) |
| `json` | 6 B | `getJson` | Sparse per-record metadata: heap-backed, lazily parsed, cached per record |
| `bytes` | 6 B | `getBytes` | Raw byte arrays: zero-copy `Uint8Array` view into SAB (e.g. base qualities) |
| `i32_array` | 6 B | `getI32Array` | Integer arrays: zero-copy `Int32Array` view, 4-byte heap-aligned (e.g. depths, GT fields) |
| `f32_array` | 6 B | `getF32Array` | Float arrays: zero-copy `Float32Array` view, 4-byte heap-aligned (e.g. coverage, AF vectors) |

All heap-backed types (`utf8`, `json`, `bytes`, `i32_array`, `f32_array`) store a 6-byte pointer in the index record: `[heap_offset: u32][heap_len: u16]`. The writer guarantees every payload is physically contiguous in the heap ring: no payload spans the ring boundary.

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

## Development

```bash
npm test        # tsup build + vitest run (forks pool, --expose-gc)
npm run typecheck
```

---

## License

MIT
