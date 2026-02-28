# Changes

## Feat: `StrandView.getConstrainedRanges` — intersection-driven min/max

**Non-breaking addition.**

Second half of the vectorized constraint pipeline. Takes the output of
`computeIntersection` and derives per-field min/max by walking only the
matching records — no full scan, no JS object allocation per record.

### Usage

```typescript
// Stage 1: build bitsets for each active predicate.
const bsScore = view.getFilterBitset('score', { kind: 'between', lo: 0.5, hi: 1.0 });
const bsChrom = view.getFilterBitset('chrom', { kind: 'in', handles: chrSet });

// Stage 2: intersect — O(N/32).
const intersection = computeIntersection([bsScore, bsChrom]);

// Stage 3: derive constrained ranges from the filtered view.
const ranges = view.getConstrainedRanges(intersection);
// ranges === {
//   start: { min: 102_400, max: 2_891_003 },
//   end:   { min: 102_423, max: 2_891_026 },
//   score: { min: 0.5,     max: 0.98      },
//   ...
// }
```

### API

```typescript
// New type
type ConstrainedRanges = Record<string, { min: number; max: number }>;

// New method on StrandView
getConstrainedRanges(intersectionBitset: Uint32Array): ConstrainedRanges;
```

`ConstrainedRanges` is also exported from the package root.

### Performance properties

- Visits only the `popcount(intersection)` matching records, not all committed records.
  A 1% pass-rate filter makes this ~100× faster than a na×ve full scan.
- Type dispatch runs once per call (not per record): a typed closure per field is
  built before the loop.
- Accumulators are parallel `Float64Array` pairs (min/max) — sequential memory
  layout, cache-friendly for schemas with many numeric fields.
- Fields with no finite value in the matching set are omitted from the result.

### Covered field types

`i32`, `u32`, `f32`, `f64`, `u16`, `u8`. Excludes `utf8_ref` (categorical handles
are ordinal but not meaningful as range stats), `bool8` (only 0/1), `i64` (BigInt),
and all heap-indirected types.

---

## Feat: vectorized bitset primitives + `StrandView.getFilterBitset`

**Non-breaking addition.**

New module `src/bitset.ts` and a new `StrandView` method that let callers evaluate filter predicates directly against the SAB ring buffer, producing a `Uint32Array` bitset in O(N/32) time with zero per-record allocations.

### New exports

```typescript
import {
  type FilterPredicate,
  createBitset,
  computeIntersection,
  popcount,
  forEachSet,
} from '@strand/core';
```

### `FilterPredicate`

Discriminated union describing a match condition against a single field:

```typescript
type FilterPredicate =
  | { kind: 'between'; lo: number; hi: number }  // inclusive range
  | { kind: 'eq';      value: number }            // exact match
  | { kind: 'in';      handles: ReadonlySet<number> }; // handle-set membership (utf8_ref)
```

### `createBitset(bitCount)` → `Uint32Array`

Allocate a zeroed bitset for `bitCount` records. Bit j is at word `j >>> 5`, shift `j & 31`.

### `computeIntersection(bitsets)` → `Uint32Array`

Bitwise AND across all inputs. Returns a new bitset — source buffers are never mutated. All inputs must be built from the same committed-count snapshot. O(N/32).

### `popcount(bs, limit?)` → `number`

Hamming-weight count of set bits, tail-masked for partial final words. O(N/32).

### `forEachSet(bs, limit, fn)` → `void`

Iterate set bits in ascending order. Uses `word & -word` to isolate the lowest set bit and `Math.clz32` for O(1) position resolution within each word. Zero words are skipped in O(1). Total work proportional to the number of matching records.

### `StrandView.getFilterBitset(field, predicate)` → `Uint32Array`

Scans every committed record in the active ring window and returns a bitset where bit j is set when the record at `seq = windowStart + j` satisfies `predicate`.

```typescript
const bs  = view.getFilterBitset('score', { kind: 'between', lo: 0.5, hi: 1.0 });
const ws  = view.windowStart;
const n   = view.committedCount - ws;

forEachSet(bs, n, j => {
  const seq = ws + j;
  cursor.seek(seq);
  render(cursor);
});
```

**Hot-loop properties:**
- No `RecordCursor` instantiation — DataView field offsets pre-computed outside loop.
- One-time type dispatch (switch runs once per call, not once per record).
- No JS object allocated per record — only a conditional bit write per match.

**Supported field types:** `i32`, `u32`, `f32`, `f64`, `u16`, `u8`, `bool8`, `utf8_ref`.
Throws `TypeError` for heap-indirected types (`utf8`, `json`, `bytes`, `i32_array`, `f32_array`) and `i64` (BigInt incompatible with number arithmetic).

### `StrandView.windowStart` → `number`

`Math.max(0, committedCount - indexCapacity)` — the inclusive start of the accessible ring window. Used to convert `forEachSet` bit indices back to absolute sequence numbers.

---

## Feat: v5 header — compact schema encoding + full column names in metadata

**Version:** v5 (STRAND_VERSION 4 → 5)

Field names are no longer stored inside binary schema bytes. The binary schema
encoding is now 4 bytes/field (type u8, flags u8, byte_offset u16), fixed width,
no padding. HEADER_SIZE is expanded from 512 to 4096 bytes.

### Why this matters

Fields with real genomic names — `Deduped_Bowtie_analytical_result`,
`Chromosome_Position_hg38` — blew past the old 420-byte schema budget. Users
were forced to use opaque ordinal aliases like `f01`, `f02`. No more.

The header fingerprint now validates structural compatibility (types, flags,
byte offsets) rather than naming — the correct invariant for binary interchange.
Names are irrelevant to the ring-buffer hot path.

### Wire format changes

**Binary schema** (compact, v5):
```
[field_count: u16]
For each field (4 bytes, fixed):
  [type_tag: u8][flags: u8][byte_offset: u16, LE]
```

**HEADER_SIZE:** 512 → 4096 bytes. The expanded tail gives ~3,900 bytes for
the metadata region after a typical schema (24 fields ≈ 98 bytes).

**Column names in metadata:** `initStrandHeader` always auto-injects a
`columns: string[]` key into the metadata JSON. `readStrandHeader` extracts it
to reconstruct named `FieldDescriptor`s, then strips it from `StrandMap.meta`
so producers' custom metadata is not polluted with this internal transport key.

### API changes

```typescript
// Producer: unchanged call signature, but non-object meta is now silently
// ignored (columns are always auto-injected regardless).
initStrandHeader(sab, map);                      // meta = { columns: [...] }
initStrandHeader(sab, map, { internTable: [...] }); // meta = { columns: [...], internTable: [...] }

// Consumer: StrandMap.meta is the caller-supplied object minus 'columns'.
const view = new StrandView(sab);
view.map.meta;          // { internTable: [...] } — columns is stripped
view.map.schema.fields; // full named FieldDescriptors, names from header meta
```

### Encoding size comparison

| | Old (v4 + names) | New (v5 compact) |
|---|---|---|
| 5-field schema | ~52 bytes | 22 bytes |
| 24 fields, 20-char avg names | ~960 bytes → **exceeds limit** | 98 bytes ✓ |
| Schema head budget | 420 bytes | 4004 bytes |
| Metadata tail budget | ~360 bytes | ~3,900 bytes |

---

## Feat: v4 header — producer metadata region

**Version:** v4 (STRAND_VERSION 3 → 4)

Non-JS producers (Rust, WASM, C) can now embed structured metadata in the header
without a side-channel JSON payload.

### Wire format

Packed immediately after the binary schema bytes in the unused header tail:

```
[92 + schema_byte_len .. +3]  meta_byte_len  u32, LE  (0 = no metadata)
[92 + schema_byte_len + 4 ..]  meta_bytes     UTF-8 JSON
```

Constraint: `92 + schema_byte_len + 4 + meta_byte_len ≤ 512`. For a typical
5-field schema (~52 bytes) this leaves ~364 bytes — enough for a full human
chromosome intern table plus query context.

### API changes

```typescript
// Producer: pass any JSON-serializable value as third argument
initStrandHeader(sab, map, { internTable: ['chr1', 'chr2', 'chrM'] });

// Consumer: available on StrandMap after readStrandHeader / new StrandView
const view = new StrandView(sab);
const { internTable } = view.map.meta as { internTable: string[] };
```

`StrandMap.meta` is `unknown | undefined`. It is absent (`undefined`) when the
producer did not supply metadata or when reading a v3 (or older) header. A
corrupt but non-empty metadata payload is silently ignored — the rest of the
header is unaffected.

### Motivation

`seqchain-native` (Rust producer) had to pass intern tables through a separate
JSON postMessage. This embeds that information in the SAB header so the consumer
gets it atomically with the buffer, without a race or an extra round-trip.

---

## Docs: language-agnostic wire protocol specification (PROTOCOL.md)

`PROTOCOL.md` at the repo root covers everything a non-TypeScript producer needs
to write correct Strand records without reading the TypeScript source:

- Header binary layout byte-by-byte (all 21 sections, v4)
- Atomics control word index table with ownership annotations
- Schema binary encoding with field padding rules
- FNV-1a 32-bit reference implementation (portable pseudocode)
- Header CRC coverage and validation sequence
- All 14 field type tags and their index-record widths
- Field flags bitmask
- Null validity bitmap layout
- Index ring slot arithmetic
- Heap ring with skip-sentinel and 4-byte alignment-padding procedures
- Step-by-step write protocol (claim → write → heap commit → COMMIT_SEQ)
- Backpressure detection and the `acknowledgeRead()` deadlock warning
- Lifecycle state machine and abort protocol

Motivated by `seqchain-native` having to reverse-engineer byte offsets from
`constants.ts` and `writer.ts`.

---

## Fix: `acknowledgeRead()` deadlock — documentation and JSDoc

**Severity:** Medium — silent deadlock when `total_committed > index_capacity`

### Root cause

`acknowledgeRead(count)` must be called unconditionally for every record consumed,
including records that are filtered or skipped. If it is called only for records
that pass a filter, or moved outside the drain loop with a filtered count, the
ring fills once committed records exceed `index_capacity`. The producer then stalls
waiting for `READ_CURSOR` to advance, while the consumer is blocked in
`waitForCommit()` — neither side can proceed.

This was never enforced at runtime; it manifested only in long-running streams or
large datasets where the ring wrapped.

### Fixed locations

**`src/view.ts` — `StrandView.acknowledgeRead()` JSDoc**

Added explicit warning with correct and incorrect code patterns.

**`README.md` — new "acknowledgeRead() is required" section**

Documents the deadlock scenario, shows the wrong and right patterns, and includes
the `Promise.all([streamWorker.run(), drain()])` pattern for concurrent
producer/consumer.

**`PROTOCOL.md` §17 — Backpressure**

Includes the same warning in the wire-protocol spec so Rust/WASM consumers
implementing their own drain loops are aware.

---

## Fix: TextDecoder rejects SharedArrayBuffer-backed views in browsers

**Affected versions:** all prior releases
**Severity:** High — `StrandView` is completely broken in every browser environment

### Root cause

The Web spec (Shared Memory spec §2.5) forbids `TextDecoder.decode()` from accepting
an `ArrayBufferView` whose `.buffer` is a `SharedArrayBuffer`. All major browsers
(Chrome, Firefox, Safari) throw:

```
TypeError: Failed to execute 'decode' on 'TextDecoder':
The provided ArrayBufferView value must not be shared.
```

Node.js permits it, so the existing test suite passed without exposing the issue.

### Fixed locations

**`src/schema.ts:129` — `decodeSchema()`**

Call path: `readStrandHeader()` → `new Uint8Array(sab, OFFSET_SCHEMA_BYTES, len)`
(header.ts) → `decodeSchema(schemaSlice)` → `decoder.decode(bytes.subarray(...))`.

`bytes.subarray()` returns another view over the same `SharedArrayBuffer`.
`TextDecoder.decode()` rejects it in browsers, crashing the `StrandView` constructor.

```diff
-const name = decoder.decode(bytes.subarray(cursor + 5, cursor + 5 + nameLen));
+const name = decoder.decode(bytes.slice(cursor + 5, cursor + 5 + nameLen));
```

**`src/view.ts:278` — `RecordCursor.getString()`**

`this._sab` is a `SharedArrayBuffer`. The `Uint8Array` constructed from it is
SAB-backed, and passing it directly to `TextDecoder.decode()` throws in browsers.

```diff
-const bytes = new Uint8Array(this._sab, physOffset, heapLen);
+const bytes = new Uint8Array(this._sab, physOffset, heapLen).slice();
 const decoded = utf8Decoder.decode(bytes);
```

The per-record `_stringCache` means each field is only copied once per `seek()`,
so the overhead is negligible on the hot read path.

**`src/view.ts:322` — `RecordCursor.getJson()`**

Identical issue to `getString()`.

```diff
-const bytes = new Uint8Array(this._sab, physOffset, heapLen);
+const bytes = new Uint8Array(this._sab, physOffset, heapLen).slice();
 const text  = utf8Decoder.decode(bytes);
```

### Not affected

- `getBytes()` — returns a raw `Uint8Array` view, never calls `TextDecoder`.
- `getI32Array()` / `getF32Array()` — typed array constructors accept SABs.
- `DataView` usage — `DataView` constructors and `get*` methods accept SABs.
- `encodeSchema()` — uses `TextEncoder.encode()`, which returns a plain `Uint8Array`.
- `StrandWriter` — uses `TextEncoder.encodeInto()` writing *into* a SAB-backed view,
  which is explicitly allowed by the spec.
