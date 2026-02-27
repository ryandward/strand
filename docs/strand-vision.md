# Strand: A Vision Beyond Streaming

## What Strand Is Today

Strand is a lock-free binary ring buffer over SharedArrayBuffer. A producer (Worker thread) writes typed records into a fixed-width index region + variable-length heap. A consumer (main thread) reads them through a zero-copy cursor. Atomics enforce visibility fences. Backpressure is automatic. The whole thing fits in ~3,300 lines of TypeScript with no dependencies.

It was designed for one job: stream genomic records from a server worker to a browser renderer without materializing JS objects.

But the architecture is more general than that.

## What We Learned Integrating Strand into GenomeHub

### The Good

- **Zero-copy rendering works.** The DevTablePage renders 50,000 rows with ~50 DOM elements. The cursor reads directly from the SAB — no JS objects, no GC pressure, no `.toArray()`. Scrolling is 60fps because each frame does ~50 DataView reads, not 50 object allocations.

- **Streaming is real.** Records appear in the virtualizer as the worker writes them. The user sees data before the stream is complete. This is fundamentally better than loading spinners.

- **The ring buffer is elegant.** Backpressure, partial-write recovery, skip sentinels, multi-consumer support — these are hard problems solved correctly. The producer never blocks the consumer. The consumer never sees half-written data.

### The Bad

#### 1. Manual Schema Declaration

We had to hand-write a 94-line schema file mapping 24 CRISPR guide fields to strand types, with indexed field names (`f0`–`fN`) because real names blew past the 420-byte header limit. We also hand-built a 42-entry intern table for low-cardinality strings.

DuckDB already inferred all of this automatically via `read_json_auto` + `DESCRIBE`. The cardinality analysis that determines which columns should be `utf8_ref` — we already computed it. The schema should be a pure function of DuckDB's output, not a hand-written artifact.

**What strand needs:** Accept an external schema descriptor (Arrow schema, DuckDB DESCRIBE output, or any typed column list) and auto-generate the binary schema. Flatten nested types. Auto-detect intern candidates from cardinality stats. The 420-byte header limit should either expand or support external schema references.

#### 2. TextDecoder Rejects SharedArrayBuffer

Every browser throws when you call `TextDecoder.decode()` on a SharedArrayBuffer-backed view. Three call sites in strand (`getString`, `getJson`, `decodeSchema`) work around this with `.slice()` — copying bytes out of the SAB before decoding.

This is a library bug. The `.slice()` calls should live inside strand, not in consumer code. But more importantly: if strand had columnar string storage (dictionary-encoded, with offsets arrays), the TextDecoder hot path could be eliminated entirely for repeated values.

#### 3. writeRecordBatch Takes JS Objects

The writer's input type is `Record<string, WritableValue>[]` — an array of JS objects. This means any caller must materialize JS objects before writing them into the SAB. When the data source is DuckDB (which returns Arrow columnar arrays), we'd have to:

```
Arrow columnar arrays → JS objects → strand binary records
```

The entire point of strand is to avoid JS object materialization. But the writer API forces it at the entry point.

#### 4. No Re-Query Pattern

When the user changes a filter, we need to: abort the current stream, clear the ring, run a new SQL query, stream new results. `writer.reset()` exists, but the consumer-side drain loop has no clean re-entry. You'd have to tear down and rebuild the view, or add out-of-band signaling. This should be a first-class workflow.

## Thinking Bigger: Strand as a Memory Format

Arrow is the standard columnar memory format. It stores data as typed arrays (one array per column) with offset buffers for variable-length types. It's designed for analytics — batch processing of entire columns at once.

Strand is a record-oriented ring buffer. It stores data as fixed-width records (one contiguous region per row) with a heap for variable-length fields. It's designed for streaming — incremental writes, zero-copy reads, backpressure.

These seem like different tools for different jobs. But are they?

### Where Arrow Falls Short in the Browser

Arrow was designed for server-side analytics (Spark, Pandas, DuckDB). In the browser, it has friction:

1. **No SharedArrayBuffer awareness.** Arrow buffers are plain ArrayBuffers. You can't share them across threads without serialization/copying. `postMessage` with transferables moves ownership — the sender loses access. There's no shared-memory, multi-reader architecture.

2. **No streaming protocol.** Arrow IPC has a streaming format, but it's batch-oriented — you receive complete RecordBatches. There's no record-level visibility fence, no backpressure, no incremental consumption. You wait for the whole batch.

3. **No ring buffer.** Arrow allocates new buffers for each batch. In a live data scenario (genomic regions scrolling, real-time filters), this means constant allocation and GC. Strand reuses the same memory.

4. **Column access requires offset arithmetic.** Reading row N of a string column in Arrow means: load the offset array, compute `offsets[N+1] - offsets[N]`, slice the data buffer. Reading the same field in strand means: seek to record N, read 6 bytes (heap_offset + heap_len). Both are O(1), but strand's is simpler for row-oriented access patterns (which is what rendering is).

### Where Strand Falls Short Compared to Arrow

1. **No columnar operations.** You can't sum a column, compute a histogram, or filter by predicate without scanning every record. DuckDB processes columns as contiguous arrays with SIMD. Strand processes rows one at a time.

2. **No ecosystem.** Arrow has bindings in every language. Parquet files map directly to Arrow memory. DuckDB outputs Arrow natively. Strand has a TypeScript library and nothing else.

3. **No dictionary encoding.** Arrow's dictionary type is essentially `utf8_ref` but more mature — it supports dictionary deltas, nested dictionaries, and automatic fallback. Strand's intern table is manual and monotonic (no eviction).

4. **Fixed record stride.** Every strand record occupies the same number of bytes regardless of null fields. Arrow's validity bitmaps + offset arrays are more space-efficient for sparse data.

### The Key Insight: The Schema Map Is the Bridge

Arrow and Strand aren't different tools. They're the same thing wearing different clothes.

An Arrow RecordBatch is: **a schema map + typed arrays**.
A Strand ring buffer is: **a schema map + typed binary slots**.

The schema map — one list of `{name, type}` entries per data object — is `O(columns)`, not `O(rows)`. For a 20-column genomic table, it's ~200 bytes. It says: "column 0 is `chrom`, type VARCHAR, interned; column 1 is `start`, type INTEGER" and so on.

That's it. That's the entire bridge. If both formats share the same schema map, the data is interchangeable. The layout difference (columnar vs row-oriented) is an implementation detail — a storage strategy, not a format boundary. A consumer that holds the schema map can read from either layout because it knows every field's name, type, offset, and encoding.

Today, strand encodes the schema into a 420-byte binary header inside the SAB. Arrow carries it as a Schema object with Field descriptors. These are isomorphic — one can be derived from the other mechanically:

```
Arrow Schema                          Strand Schema
  Field("chrom", Utf8, dict=true)  →    { name: "chrom", type: "utf8_ref" }
  Field("start", Int32)            →    { name: "start", type: "i32" }
  Field("score", Float64)          →    { name: "score", type: "f64" }
```

The schema map is the Rosetta Stone. Serialize it once, share it everywhere. The typed binary data underneath is just bytes addressed by that map. Whether those bytes are laid out column-major (Arrow) or row-major (Strand) or in a ring buffer with Atomics fences is a transport decision, not a data decision.

For strand consumption, **order is what matters**. The binary layout is determined entirely by position in the sequence — field 0 starts at byte 0, field 1 at byte 0 + sizeof(field 0), and so on. Names are irrelevant to the wire format. This means the schema is really two separate things:

1. **The type sequence** (what the binary header needs): `[utf8_ref, i32, i32, utf8_ref, f64, utf8, ...]` — a few bytes per field, determines byte offsets, alignment, record stride. This is tiny and goes in the SAB header.

2. **The name map** (what the consumer needs): `[0→"chrom", 1→"start", 2→"end", 3→"strand", 4→"score", ...]` — a lookup table mapping ordinal position to human-readable names. This is metadata. It does not belong in the binary header.

Today strand encodes both into the 512-byte header. That's why we hit the 420-byte limit — field names like `tags_signed_distance` bloat the binary header with data that has no business being there. The `f0`/`f1` hack worked because it proved that names don't affect the layout. The right fix is to separate them: type sequence in the header, name map as a sidecar (JSON, postMessage, whatever).

This also means auto-serialization isn't a feature request — it's the fundamental design principle. You should never hand-write a strand schema. You should never manually map DuckDB types to strand types. The schema map should be derived automatically from whatever typed the data in the first place (DuckDB DESCRIBE, Arrow Schema, Parquet footer, BAM header). It's always tiny. It's always the same information. And the name map is always separate from the binary layout.

### The Synthesis: What If Strand Subsumed Arrow's Role?

Strand already has:
- Typed field descriptors (i32, f64, utf8, utf8_ref, bool8, json, bytes, typed arrays)
- A binary schema with field offsets and alignment
- Null validity bitmaps
- Variable-length heap with contiguous-write guarantees
- Intern handles for dictionary-encoded strings
- Multi-consumer support via Atomics

What if strand also had:
- **Columnar storage mode.** Instead of row-major fixed-width records, optionally store data column-major. Each field gets a contiguous typed array. The ring buffer manages column chunks instead of record slots. This enables SIMD-friendly scans while keeping the streaming/backpressure semantics.

- **Arrow IPC compatibility.** Read and write Arrow RecordBatches directly. Strand becomes the SharedArrayBuffer-backed, streaming-aware Arrow runtime for the browser. DuckDB outputs Arrow batches → strand ingests them without JS object materialization → cursor reads individual cells for rendering.

- **Columnar writer.** `writeColumnBatch(columns: Map<string, TypedArray>)` alongside the existing `writeRecordBatch()`. The producer writes entire column vectors. The consumer can read either row-oriented (cursor) or column-oriented (typed array views). The ring manages column-chunk visibility atomically.

- **Predicate pushdown.** `view.scan(predicates)` returns a bitset of matching record indices, computed directly on the binary data. No JS objects, no cursor seeks — just DataView reads in a tight loop. This isn't DuckDB-grade SIMD, but it's 10-100x faster than materializing objects and filtering in JS.

- **Schema inference from Arrow.** Given an Arrow Schema object (from DuckDB's `conn.query().schema`), auto-generate the strand binary schema. Map Arrow types → strand types. Detect dictionary candidates from the Arrow dictionary type or from cardinality analysis. Build the intern table from Arrow dictionary arrays.

- **Query-aware lifecycle.** First-class support for the re-query pattern: `writer.reset()` + consumer re-arm as a coordinated operation. The view exposes a `generation` counter that increments on each reset. The consumer drain loop checks `generation` and restarts automatically. No out-of-band signaling needed.

### The DuckDB Marriage

DuckDB WASM is the best SQL engine in the browser. It handles schema inference, JSON/CSV/Parquet loading, filtering, sorting, aggregation, window functions. Its output is Arrow RecordBatches.

Today, consuming DuckDB output in the browser means:
```
conn.query() → Arrow Table → .toArray() → JS objects → render
```

The `.toArray()` step is catastrophic at scale. 500K rows × 20 fields = 10M object property allocations = hundreds of MB of GC-tracked heap.

With strand as the Arrow-aware rendering transport:
```
conn.query() → Arrow RecordBatches → StrandWriter.writeArrowBatch() → SAB → cursor → render
```

No JS objects. No GC. The Arrow columnar arrays are transcribed directly into strand's binary format in a worker thread. The main thread reads individual cells on demand via the cursor. Only the ~50 visible rows are ever touched.

But if strand had columnar mode, it could go further:
```
conn.query() → Arrow RecordBatches → zero-copy into strand column buffers (SAB) → render
```

The Arrow typed arrays could potentially be placed directly in the SharedArrayBuffer. No transcription at all — just pointer arithmetic. The strand header describes where each column lives. The cursor reads from column arrays instead of row records.

This would make strand not a replacement for Arrow, but **Arrow's SharedArrayBuffer runtime** — the missing piece that makes Arrow work in multi-threaded browser applications.

### Beyond Tables: What Else Could Strand Power?

If strand is a general-purpose streaming binary format over SharedArrayBuffer, it's not limited to tables:

- **Genome browser tracks.** BAM records, VCF variants, BED features — all streaming from a worker into a canvas renderer. The renderer reads only the visible genomic window. Backpressure prevents the worker from outrunning the display.

- **Real-time dashboards.** WebSocket → worker → strand → chart components. Each chart reads from the same SAB with multi-consumer support. No Redux store, no React state, no re-renders — just cursor reads in `requestAnimationFrame`.

- **Collaborative editing.** Multiple browser tabs sharing the same strand buffer (via BroadcastChannel + SharedArrayBuffer). One tab streams data, others consume. The multi-consumer protocol already handles this.

- **WASM interop.** A Rust/C++ WASM module writes directly into the SAB via the WASM linear memory → strand claim/commit protocol. No JS bridge for hot-path data. The `claimSlot()`/`commitSlot()` API already supports this.

- **Server-side streaming.** Node.js worker_threads share SABs natively. A genomic file parser (htslib via WASM, or native Node addon) writes strand records from a worker thread. The main thread serves them via SSE/WebSocket. The SAB is the buffer between disk I/O and network I/O.

## Concrete Asks for Strand Engineers

### Must Fix (Blocking Real Adoption)

1. **TextDecoder SAB workaround.** `.slice()` before decode in `getString()`, `getJson()`, `decodeSchema()`. This is a one-line fix per call site but it should be in the library, not in consumer code.

2. **Schema auto-generation from external type systems.** Accept a column descriptor array (name + type + cardinality) and produce the strand schema + intern table automatically. No manual `f0`/`f1` naming. No hand-built intern tables. The 420-byte header limit needs a solution — either expand it, use external schema references, or accept that indexed names are the norm and provide a metadata sidecar API.

3. **Arrow-native writer.** `writeArrowBatch(batch: ArrowRecordBatch, internMap?: Map<string, Map<string, number>>)` that reads directly from Arrow columnar arrays without materializing JS objects. This is the critical integration point with DuckDB.

### Should Build (Enables the Next Level)

4. **Re-query lifecycle.** `writer.reset()` + `view.onReset(callback)` as a coordinated pair. Generation counter on the view. Consumer drain loop re-arms automatically. This is the standard workflow for any filtered/sorted data view.

5. **Predicate scan.** `view.scan(field, op, value) → Uint32Array` (matching indices). Operates directly on the binary data. Supports: `=`, `!=`, `<`, `>`, `<=`, `>=`, `BETWEEN`, `ILIKE` (for utf8 fields via heap decode). Returns a bitset or index array. 10-100x faster than JS object filtering.

6. **Columnar writer mode.** Accept typed arrays instead of record arrays. This is a wire format change (column-major instead of row-major) but the ring buffer semantics (claim, commit, backpressure, multi-consumer) are identical.

### Could Explore (The Big Vision)

7. **Arrow IPC reader/writer.** Ingest Arrow IPC streams directly into strand. Emit strand data as Arrow IPC. This makes strand interoperable with every Arrow-compatible tool.

8. **Zero-copy Arrow → strand column placement.** Place Arrow typed arrays directly into the SAB without copying. The strand header describes column locations. This eliminates all transcription overhead.

9. **WASM-native producer.** A C/Rust library that writes strand records from WASM linear memory. No JS bridge. The claim/commit Atomics work from WASM's `i32.atomic.rmw.add` instructions.

10. **Multi-buffer federation.** Multiple strand buffers (one per query, one per track, one per data source) with a unified cursor that joins across them. Like DuckDB's multi-table queries but in shared memory.

## Summary

Strand today is a streaming ring buffer. It solves the "get binary data from a worker to the main thread without JS objects" problem elegantly.

But the architecture — typed schemas, binary layout, Atomics-based visibility fences, multi-consumer support — is general enough to be a **SharedArrayBuffer-native memory format for the browser**. It could be where Arrow and the DOM meet: the layer that makes typed columnar data accessible to rendering code without ever touching the JS heap.

The immediate blocker is the gap between DuckDB (which outputs Arrow) and strand (which inputs JS objects). Close that gap with an Arrow-native writer, and strand becomes the rendering transport for any SQL query engine in the browser. Widen it to columnar mode, and strand becomes the browser's Arrow runtime — with streaming semantics that Arrow itself lacks.

## Appendix: How Small Can the Type Sequence Be?

Most data tables have fewer than 100 columns. Genomic tables typically have 10–30. The type sequence only needs to encode the type of each field in declaration order. Names are in the sidecar. So how compact can this get?

Strand has 14 field types today: `i32, u32, i64, f32, f64, u16, u8, bool8, utf8, utf8_ref, json, bytes, i32_array, f32_array`. That's 14 values — fits in 4 bits.

**Option A: 4 bits per field (nibble-packed)**

Each field is one nibble. Two fields per byte. A 30-column table is 15 bytes. A 100-column table is 50 bytes. The type sequence for any realistic schema fits in a single cache line.

```
Header: [field_count: u8][type_nibbles: ceil(field_count/2) bytes]

Example (20 columns):
  01 byte:  field_count = 20
  10 bytes: type nibbles
  ─────────
  11 bytes total
```

With flags (nullable, sorted_asc, sorted_desc) you need 3 more bits per field. That's 7 bits — round to 1 byte per field.

**Option B: 1 byte per field (type + flags)**

```
Byte layout: [type: 4 bits][nullable: 1][sorted_asc: 1][sorted_desc: 1][reserved: 1]

Header: [field_count: u8][field_bytes: field_count bytes]

Example (20 columns):
  01 byte:  field_count = 20
  20 bytes: field descriptors
  ─────────
  21 bytes total
```

A 100-column table with full flag support: 101 bytes. That's it. The entire type sequence. No field names, no padding, no alignment metadata (byte offsets are derived from the type sequence at read time — `buildSchema()` already does this).

**Option C: Varint-encoded with inline intern table**

For `utf8_ref` fields, the intern table values could follow the type sequence as length-prefixed strings. A column with 5 distinct values ("chr1"..."chr5") adds ~30 bytes. This keeps the entire schema + dictionary in one contiguous block.

```
Header:
  [field_count: u8]
  [field_bytes: field_count × 1 byte]
  for each utf8_ref field:
    [intern_count: u16]
    [intern_values: intern_count × (len: u8, utf8_bytes)]
```

A 20-column table with 2 interned columns (34 chromosome names + 2 strand symbols): ~21 + 2 + (34 × ~6) + (2 × 2) ≈ 231 bytes. Still trivially small. And the consumer gets the full intern table without a separate sidecar message.

**Recommendation:**

Option B (1 byte per field) is the sweet spot. It's dead simple, supports flags, and a 100-column table is 101 bytes — leaving 411 bytes in the current 512-byte header for the intern table, a schema version tag, or future extensions. No more `f0`/`f1` hacks. No more hitting the 420-byte limit. The name map travels as a separate JSON sidecar via `postMessage` — where it belongs.

If the intern table also moves to the sidecar (alongside the name map), then the binary header is just:

```
[magic: 4B][version: 2B][geometry: 20B][atomics: 60B][field_count: 1B][types: ≤100B]
```

Under 200 bytes for any realistic schema. The remaining 300+ bytes of the 512-byte header become free space — or the header could shrink to 256 bytes.
