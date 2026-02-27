# Changes

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
