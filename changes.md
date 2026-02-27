# Changes

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
