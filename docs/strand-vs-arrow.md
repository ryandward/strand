# What Strand Actually Is (and Isn't) Relative to Arrow

## The Overlap

Strand reinvented a subset of Arrow's type system and schema format. This is not a criticism — it's a fact that should inform what happens next.

| Concept | Arrow | Strand |
|---|---|---|
| Typed field descriptors | `Field(name, type, nullable, metadata)` | `{ name, type, byteOffset, flags }` |
| Integer types | Int8, Int16, Int32, Int64, UInt8, UInt16, UInt32, UInt64 | u8, u16, i32, u32, i64 |
| Float types | Float16, Float32, Float64 | f32, f64 |
| Boolean | Bool (1-bit packed) | bool8 (1 byte) |
| Variable-length strings | Utf8 (offset array + data buffer) | utf8 (heap_offset u32 + heap_len u16) |
| Dictionary encoding | Dictionary(indices, dictionary) with deltas | utf8_ref (u32 handle into extern intern table) |
| Null handling | Validity bitmap per column | Validity bitmap per record (v3) |
| Binary data | Binary (offset array + data buffer) | bytes (heap pointer) |
| Typed arrays | FixedSizeList(Int32) etc. | i32_array, f32_array (heap pointer) |
| JSON/metadata | Extension types or metadata | json (heap pointer, JSON.parse on read) |
| Schema validation | Schema comparison | FNV-1a fingerprint |
| Binary serialization | Flatbuffers IPC schema message | Custom binary encoding in 420-byte header |

The type-to-type mapping is mechanical. `Arrow Int32 → strand i32`. `Arrow Utf8 + dictionary → strand utf8_ref`. `Arrow Float64 → strand f64`. Nothing about strand's type system is novel relative to Arrow. It's a simplified projection — 14 types instead of Arrow's ~30+, no nested types, no unions, no structs.

## What Strand Has That Arrow Does Not

Everything below this line has zero equivalent in the Arrow specification or any Arrow implementation.

### 1. SharedArrayBuffer as the memory substrate

Arrow buffers are plain ArrayBuffers. In the browser, an ArrayBuffer belongs to one thread. To share it across threads you must either:
- `postMessage` with transfer — the sender loses the buffer entirely
- `postMessage` with structured clone — a full byte-for-byte copy
- Serialize to some wire format and deserialize on the other side

Strand's entire data structure lives in a SharedArrayBuffer. Both the producer (Worker) and the consumer (main thread) hold live references to the same memory. No copying, no transferring, no serializing. The producer writes bytes. The consumer reads them. Same physical memory.

This is not an optimization. This is a different computation model. Arrow assumes single-owner memory. Strand assumes shared memory.

### 2. Atomics-based visibility protocol

Arrow has no concept of "when does data become visible to another thread." It has IPC messages (send a RecordBatch, receive a RecordBatch), but those are message-passing, not shared memory.

Strand uses Atomics to implement a visibility fence:

```
Producer                          Consumer
────────                          ────────
write fields to SAB               (sees nothing yet)
Atomics.store(COMMIT_SEQ, N)      Atomics.load(COMMIT_SEQ) → N
                                  now safe to read records 0..N-1
```

This is the core primitive. Everything else — backpressure, multi-consumer, partial-write recovery — is built on top of this Atomics fence. Arrow has nothing like it because Arrow doesn't operate on shared memory.

### 3. Ring buffer with bounded memory

Arrow allocates a new buffer for every RecordBatch. In a streaming scenario (DuckDB returning 500K rows in batches of 1000), that's 500 separate allocations. The consumer holds references to old batches while processing new ones. GC must reclaim them.

Strand uses a fixed-size ring buffer. The producer writes into slot `seq % capacity`. When the consumer acknowledges it's done with old records, those slots become available for reuse. Total memory is bounded: `header + (capacity × stride) + heap_size`. For a 2048-record ring with 120-byte stride and 256KB heap, that's ~500KB. Forever. No GC.

### 4. Backpressure

When the ring is full (producer has lapped the slowest consumer), the producer blocks:

```
Atomics.wait(CTRL_READ_CURSOR, currentValue, 200ms)
```

The consumer unblocks it by calling `acknowledgeRead()`:

```
Atomics.store(CTRL_READ_CURSOR, upTo)
Atomics.notify(CTRL_READ_CURSOR, 1)
```

Arrow has no backpressure mechanism. If a producer generates RecordBatches faster than a consumer processes them, batches accumulate in memory. There's no coordination protocol — it's the caller's responsibility to manage flow.

### 5. Multi-consumer coordination

Up to 8 consumers can independently register, read from, and acknowledge the same SAB:

```
const token = view.registerConsumer()    // CAS on vacant slot
view.acknowledgeRead(upTo, token)        // advance per-consumer cursor
view.releaseConsumer(token)              // free slot
```

The producer gates on `min(all registered consumer cursors)`. The slowest consumer determines how far the ring can advance.

Arrow has no multi-reader protocol. You can hand the same ArrayBuffer to multiple consumers, but there's no coordination — no acknowledgment, no backpressure gating on the slowest reader.

### 6. Row-major layout

Arrow stores data column-major: one contiguous array per column. Reading all fields of row N requires N array accesses at potentially distant memory addresses.

Strand stores data row-major: one contiguous record per row. Reading all fields of row N is a single contiguous memory read at `INDEX_START + (N % capacity) × stride`.

For rendering — where you read all 20 fields of each of ~50 visible rows — row-major has better cache locality. For analytics — where you scan one column across 500K rows — column-major is better.

This is a genuine architectural difference, not just a simplification.

### 7. Heap ring for variable-length data

Arrow uses offset arrays: a column of strings is an Int32Array of byte offsets into a contiguous data buffer. The offset array grows linearly with record count.

Strand uses a circular heap: variable-length data (strings, JSON, byte arrays) is written into a fixed-size heap region that wraps around. Skip sentinels prevent data from spanning the wrap boundary. The consumer computes `physAddress = heapStart + (mono_offset % heap_capacity)`.

This means strand's variable-length storage is bounded (same as the index ring). Arrow's offset arrays are unbounded — a new batch means a new offset array and a new data buffer.

### 8. Abort / lifecycle protocol

Strand has a formal lifecycle state machine:

```
INITIALIZING → STREAMING → EOS
                         → ERROR (via abort)
```

The consumer can signal abort (`signalAbort()`), which sets `CTRL_ABORT = 1` and wakes the producer. The producer catches `StrandAbortError` and calls `abort()` to set `STATUS_ERROR`.

Arrow has no lifecycle protocol. A RecordBatch is either complete or it doesn't exist.

### 9. Partial-write recovery

If the producer crashes between `claimSlot()` and `commitSlot()`, the next writer detects `WRITE_SEQ > COMMIT_SEQ` and rewinds to the last committed position. No orphaned slots are ever visible to the consumer.

Arrow has no concept of partial writes because it has no concept of in-place mutation of shared memory.

## Summary Table

| | Arrow | Strand |
|---|---|---|
| **Memory model** | Single-owner ArrayBuffer | Shared-memory SAB |
| **Thread coordination** | Message passing (postMessage, IPC) | Atomics (load, store, wait, notify, CAS) |
| **Memory lifetime** | Allocate per batch, GC reclaims | Fixed ring buffer, bounded forever |
| **Backpressure** | None (caller manages) | Automatic (Atomics.wait/notify) |
| **Multi-consumer** | None (caller manages) | 8 slots, independent cursors, CAS registration |
| **Layout** | Column-major | Row-major |
| **Variable-length storage** | Offset arrays (unbounded) | Circular heap (bounded) |
| **Visibility** | Complete batches via IPC | Per-commit Atomics fence |
| **Lifecycle** | None | init → streaming → eos / error |
| **Type system** | ~30+ types, nested, unions | 14 flat types |
| **Schema format** | Flatbuffers, cross-language | 420-byte binary header, TypeScript only |
| **Ecosystem** | Every language, every tool | TypeScript |

## What This Means

Strand is not Arrow. Strand is also not "Arrow but worse." They solve different problems:

**Arrow answers:** "How do I represent typed columnar data in memory so that analytics engines, serialization formats, and language runtimes all agree on the layout?"

**Strand answers:** "How do I stream typed records from a Worker thread to the main thread over shared memory with zero-copy reads, bounded memory, backpressure, and multi-consumer support?"

Arrow is a **memory format**. Strand is a **transport protocol** that happens to include a type system because it needed one to describe its binary layout.

The type system overlap is real but incidental. Strand needed to describe the shape of each record so the cursor knows where to find each field. It defined 14 types for this purpose. Those 14 types happen to be a subset of Arrow's types because both are describing the same underlying reality (integers, floats, strings, booleans).

## The Right Framing for Strand Engineers

Don't build strand into a competing memory format. Arrow already won that.

Instead: strand is the **shared-memory transport layer that Arrow doesn't have**. Its unique contributions are the SAB substrate, the Atomics protocol, the ring buffer, the backpressure, and the multi-consumer coordination. Those are hard problems solved correctly. Nothing else in the browser ecosystem does this.

The type system should be treated as an internal implementation detail, not a public surface to extend. The public contract should be:
1. Give me a schema (from Arrow, from DuckDB DESCRIBE, from anywhere)
2. I'll derive the binary layout automatically
3. I'll manage the ring buffer, the Atomics, the backpressure
4. You read fields through the cursor

Whether the internal layout is row-major (current) or column-major (future) is strand's decision, not the caller's. The cursor API doesn't change either way.

The 14 strand types are sufficient for all genomic data we've encountered. If a new Arrow type is needed, map it. Don't build a type system — build a type mapping table. That table is ~20 lines of code:

```
Arrow Int32       → strand i32
Arrow UInt32      → strand u32
Arrow Int64       → strand i64
Arrow Float32     → strand f32
Arrow Float64     → strand f64
Arrow Bool        → strand bool8
Arrow Utf8        → strand utf8  (or utf8_ref if cardinality < 1000)
Arrow Dictionary  → strand utf8_ref
Arrow Binary      → strand bytes
Arrow FixedSizeList(Int32)  → strand i32_array
Arrow FixedSizeList(Float32) → strand f32_array
// everything else → strand json (serialize to JSON, store in heap)
```

That's the bridge. Not a format specification. Not a new standard. A mapping table and the transport layer that makes Arrow data live in shared memory.
