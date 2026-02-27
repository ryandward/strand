# Strand Wire Protocol — Version 3

**Scope:** Everything a non-TypeScript producer (Rust, WASM, C, Python) needs to write
correct Strand records into a `SharedArrayBuffer` without reading the TypeScript source.

**Not covered:** Consumer-side APIs (`StrandView`, `RecordCursor`, `allocateCursor`).
The consumer is always a TypeScript/JS caller in `@strand/core`. This document describes
only the producer-observable binary contract.

---

## Contents

1. [Byte ordering](#1-byte-ordering)
2. [Buffer layout](#2-buffer-layout)
3. [Header — static section](#3-header--static-section)
4. [Header — Atomics control words](#4-header--atomics-control-words)
5. [Header — schema section](#5-header--schema-section)
6. [Schema binary encoding](#6-schema-binary-encoding)
7. [FNV-1a 32-bit hash](#7-fnv-1a-32-bit-hash)
8. [Field type tags and wire widths](#8-field-type-tags-and-wire-widths)
9. [Field flags](#9-field-flags)
10. [Null validity bitmap](#10-null-validity-bitmap)
11. [Index region — record slot layout](#11-index-region--record-slot-layout)
12. [Heap region — variable-length payloads](#12-heap-region--variable-length-payloads)
13. [Heap skip sentinel](#13-heap-skip-sentinel)
14. [Heap alignment for typed arrays](#14-heap-alignment-for-typed-arrays)
15. [Write protocol — step-by-step](#15-write-protocol--step-by-step)
16. [Backpressure](#16-backpressure)
17. [Lifecycle state machine](#17-lifecycle-state-machine)
18. [Abort protocol](#18-abort-protocol)
19. [Validation on attach](#19-validation-on-attach)
20. [Magic and version constants](#20-magic-and-version-constants)

---

## 1. Byte ordering

**All multi-byte integers are little-endian.** This applies to every field in the
header, every field in the schema binary encoding, and every field written into
index record slots.

`Atomics` operations on `Int32Array` use the platform's native byte order, but since
producer and consumer always share the same process (or a `SharedArrayBuffer` on the
same host), their native byte order is identical. On little-endian hosts (all modern
x86/ARM64) this is consistent with the rest of the format.

Big-endian platforms are not supported. `@strand/core v3` refuses to initialize a
header on a big-endian system.

---

## 2. Buffer layout

A Strand `SharedArrayBuffer` is divided into three contiguous regions:

```
┌─────────────────────────────────────────────────────────────────────┐
│  HEADER          512 bytes            byte offset 0                 │
├─────────────────────────────────────────────────────────────────────┤
│  INDEX REGION    index_capacity × record_stride bytes               │
│                  byte offset 512                                     │
├─────────────────────────────────────────────────────────────────────┤
│  HEAP REGION     heap_capacity bytes                                 │
│                  byte offset 512 + index_capacity × record_stride   │
└─────────────────────────────────────────────────────────────────────┘
```

```
total_bytes = 512 + (index_capacity × record_stride) + heap_capacity
heap_start  = 512 + (index_capacity × record_stride)
```

`index_capacity` must be a power of 2. `record_stride` must be divisible by 4.

---

## 3. Header — static section

The static section occupies bytes 0–27. It is written once by `initStrandHeader()`
and never modified. All values are little-endian `u32`.

| Byte offset | Size | Name             | Value / notes                                            |
|-------------|------|------------------|----------------------------------------------------------|
| 0           | u32  | `magic`          | `0x5354524E` — bytes `'N'`, `'R'`, `'T'`, `'S'` in LE  |
| 4           | u32  | `version`        | `3` for this document                                    |
| 8           | u32  | `schema_fp`      | FNV-1a 32-bit of the binary schema encoding (§6, §7)    |
| 12          | u32  | `record_stride`  | Byte length of one index record slot, 4-byte aligned     |
| 16          | u32  | `index_capacity` | Ring capacity in records; must be a power of 2           |
| 20          | u32  | `heap_capacity`  | Heap region size in bytes                                |
| 24          | u32  | `header_crc`     | FNV-1a 32-bit of bytes 0–23 (the six fields above)      |

`header_crc` is computed over the six fields at bytes 0–23 (magic through
heap_capacity) and stored at byte 24. A reader recomputes this hash before using
any geometry value. A mismatch indicates memory corruption.

---

## 4. Header — Atomics control words

Bytes 28–87 are a sequence of `i32` words accessed exclusively via `Atomics`
operations. They are indexed as an `Int32Array` view starting at SAB byte 0, so
`ctrl[i]` maps to SAB byte `i × 4`.

All control words are initialized to `0` by `initStrandHeader()`, except consumer
slots (indices 14–21) which are initialized to `0x7FFFFFFF` (vacant sentinel).

```
Int32Array index | Byte offset | Name              | Owner      | Role
─────────────────┼─────────────┼───────────────────┼────────────┼──────────────────────────────────
7                | 28          | WRITE_SEQ         | Producer   | Next sequence number to claim
8                | 32          | COMMIT_SEQ        | Producer   | Highest committed sequence number
9                | 36          | READ_CURSOR       | Consumer   | Global acknowledged read position
10               | 40          | STATUS            | Producer   | Stream lifecycle state (§17)
11               | 44          | HEAP_WRITE        | Producer   | Monotonic heap write cursor (bytes)
12               | 48          | HEAP_COMMIT       | Producer   | Monotonic heap commit cursor (bytes)
13               | 52          | ABORT             | Consumer   | Set to 1 to request abort
14               | 56          | CONSUMER_SLOT[0]  | Consumer   | Per-consumer ack cursor (multi-consumer)
15               | 60          | CONSUMER_SLOT[1]  | Consumer   | ″
16               | 64          | CONSUMER_SLOT[2]  | Consumer   | ″
17               | 68          | CONSUMER_SLOT[3]  | Consumer   | ″
18               | 72          | CONSUMER_SLOT[4]  | Consumer   | ″
19               | 76          | CONSUMER_SLOT[5]  | Consumer   | ″
20               | 80          | CONSUMER_SLOT[6]  | Consumer   | ″
21               | 84          | CONSUMER_SLOT[7]  | Consumer   | ″
```

**WRITE_SEQ** is incremented (claimed) first via `Atomics.add`. A producer owns the
slot for sequence `seq` once it has claimed it, but the slot is not visible to consumers
until `COMMIT_SEQ` is advanced to `seq + 1`.

**COMMIT_SEQ** is the consumer visibility fence. Consumers may only read records with
`seq < COMMIT_SEQ`. A producer advances `COMMIT_SEQ` only after all field writes
(including heap commits) for that record are complete.

**READ_CURSOR** tracks how many records the consumer has finished processing. The
producer subtracts this from `WRITE_SEQ` to detect a full ring (§16).

**Consumer slots** (indices 14–21) are used in multi-consumer mode. Unoccupied slots
hold `0x7FFFFFFF`. A consumer claims a slot by CAS from `0x7FFFFFFF` to its current
acknowledged position. The producer uses `min(occupied slots)` instead of `READ_CURSOR`
for backpressure when any slot is occupied.

---

## 5. Header — schema section

Bytes 88–511 hold the binary-encoded schema descriptor.

| Byte offset | Size | Name              | Notes                                          |
|-------------|------|-------------------|------------------------------------------------|
| 88          | u32  | `schema_byte_len` | Length in bytes of the schema encoding below  |
| 92          | …    | schema bytes      | `schema_byte_len` bytes; up to 420 bytes total |
| 92 + len    | …    | (unused)          | Zeroed by `initStrandHeader()`                 |

The binary schema encoding is described in §6. The FNV-1a hash of these bytes
(not including `schema_byte_len`) is `schema_fp` (stored at byte 8).

---

## 6. Schema binary encoding

All values little-endian. This is the canonical input for FNV-1a fingerprinting.

```
[field_count: u16]

For each field (in schema declaration order):
  [type_tag:    u8]           — see §8
  [flags:       u8]           — see §9
  [byte_offset: u16]          — field's start byte within the fixed-width record slot
  [name_len:    u8]           — UTF-8 byte length of the field name
  [name_bytes:  name_len × u8]
  [padding:     0–3 zero bytes] — pad total field encoding to next 4-byte boundary

  Raw field encoding size = 5 + name_len
  Padded size             = ceil((5 + name_len) / 4) × 4
```

`byte_offset` is stored explicitly in the schema encoding. A reader never has to
recompute field alignment rules — `byte_offset` gives the exact position within
the record slot.

The order of fields in the encoding is the schema declaration order. `buildSchema()`
in `@strand/core` assigns `byte_offset` values using this alignment rule: each field
is aligned to `min(field_byte_width, 4)` bytes, laid out in declaration order after
any null validity bitmap bytes at the start of the slot (§10).

---

## 7. FNV-1a 32-bit hash

Used for both `schema_fp` (fingerprint of schema binary encoding) and `header_crc`
(checksum of header geometry bytes 0–23).

```
FNV offset basis : 0x811C9DC5
FNV prime        : 0x01000193

hash ← 0x811C9DC5
for each byte b in input:
    hash ← (hash XOR b) * 0x01000193   [truncated to 32 bits, wrapping multiply]
return hash as u32
```

In languages with 64-bit arithmetic, mask the multiply result to 32 bits after each
step: `hash = ((hash ^ b) * 0x01000193) & 0xFFFFFFFF`.

The TypeScript reference uses `Math.imul(hash, 0x01000193)` to ensure the multiplication
stays within 32-bit integer semantics regardless of V8's internal float representation.

---

## 8. Field type tags and wire widths

Each field in the schema has a type tag (u8) and a fixed byte width inside the index
record slot. The type tag is stored in the schema binary encoding and validated on
`readStrandHeader()`.

| Tag | Type name   | Index width | Heap-backed | Notes                                                 |
|-----|-------------|-------------|-------------|-------------------------------------------------------|
| 0   | `i32`       | 4 bytes     | No          | Signed 32-bit integer, LE                             |
| 1   | `u32`       | 4 bytes     | No          | Unsigned 32-bit integer, LE                           |
| 2   | `i64`       | 8 bytes     | No          | Signed 64-bit integer, LE                             |
| 3   | `f32`       | 4 bytes     | No          | IEEE 754 single-precision float, LE                   |
| 4   | `f64`       | 8 bytes     | No          | IEEE 754 double-precision float, LE                   |
| 5   | `u16`       | 2 bytes     | No          | Unsigned 16-bit integer, LE                           |
| 6   | `u8`        | 1 byte      | No          | Unsigned 8-bit integer                                |
| 7   | `bool8`     | 1 byte      | No          | 0 = false, 1 = true                                   |
| 8   | `utf8`      | 6 bytes     | Yes         | `[heap_offset: u32][heap_len: u16]`                   |
| 9   | `utf8_ref`  | 4 bytes     | No          | `[intern_handle: u32]` — index into side-channel table|
| 10  | `json`      | 6 bytes     | Yes         | `[heap_offset: u32][heap_len: u16]` — same as `utf8`  |
| 11  | `bytes`     | 6 bytes     | Yes         | `[heap_offset: u32][heap_len: u16]` — raw bytes, 1-byte aligned |
| 12  | `i32_array` | 6 bytes     | Yes         | `[heap_offset: u32][heap_len: u16]` — `heap_len` is byte count; heap payload **must be 4-byte aligned** |
| 13  | `f32_array` | 6 bytes     | Yes         | `[heap_offset: u32][heap_len: u16]` — `heap_len` is byte count; heap payload **must be 4-byte aligned** |

Tags 14–255 are reserved. A reader encountering an unknown tag must reject the header.

**Heap-backed pointer format:** For tags 8, 10, 11, 12, 13 the index record stores a
6-byte pointer:

```
[heap_offset: u32, LE][heap_len: u16, LE]
```

- `heap_offset` is the **monotonic** heap write cursor value at the time the payload
  was written — not a physical byte offset.
- Physical address: `heap_start + (heap_offset % heap_capacity)`
- `heap_len` is the payload byte count (for typed arrays, byte count not element count).
- A zero `heap_len` is valid (empty string, zero-length array). Consumers treat it as
  an empty value without following the pointer.

---

## 9. Field flags

Flags is a bitmask (u8) stored in the schema binary encoding.

| Bit | Mask | Name                | Meaning                                                              |
|-----|------|---------------------|----------------------------------------------------------------------|
| 0   | 0x01 | `FIELD_FLAG_NULLABLE`    | Field may be absent in a record; null tracked by validity bitmap (§10) |
| 1   | 0x02 | `FIELD_FLAG_SORTED_ASC`  | Values are monotonically non-decreasing across committed records     |
| 2   | 0x04 | `FIELD_FLAG_SORTED_DESC` | Values are monotonically non-increasing across committed records     |

Bits 3–7 are reserved and must be zero.

`FIELD_FLAG_SORTED_ASC` enables `StrandView.findFirst()` binary search on the consumer
side. A producer that declares `SORTED_ASC` but writes out-of-order values will cause
silent incorrect binary search results — no runtime enforcement exists.

---

## 10. Null validity bitmap

When a schema contains one or more `FIELD_FLAG_NULLABLE` fields, each record slot
begins with a null validity bitmap.

```
bitmap_bytes = ceil(nullable_field_count / 8)
```

If `nullable_field_count == 0`, the bitmap is absent (0 bytes).

The bitmap occupies bytes `[0 .. bitmap_bytes)` of the record slot. All data fields
start after the bitmap. `buildSchema()` assigns `byte_offset` values accordingly —
the bitmap size is already reflected in the stored `byte_offset` of every field.

**Bitmap layout:** Each nullable field is assigned an ordinal `nullableBitIndex` in
schema declaration order (0-indexed among nullable fields only). The bit for
`nullableBitIndex = k` is:

```
byte index within bitmap: k / 8  (integer division)
bit  index within byte:   k % 8  (LSB = bit 0)
```

**Bit value:** `1` = field was written (value present). `0` = field was omitted (null).

When writing a nullable field, the producer must set the corresponding bit to 1.
When omitting a nullable field, the bit must remain 0 (slots are zeroed before each
write; producers must not leave stale values from a prior lap in the ring).

---

## 11. Index region — record slot layout

The index region starts at byte offset `512` and contains `index_capacity` slots of
`record_stride` bytes each.

**Slot for sequence number `seq`:**

```
slot_index     = seq & (index_capacity - 1)    [power-of-2 modulo]
slot_byte_offset = 512 + slot_index * record_stride
```

Each slot is a flat byte array of `record_stride` bytes. Fields are placed at
their declared `byte_offset` within the slot. Bytes not covered by any field
are padding (value is unspecified; readers must not interpret them).

**Zeroing requirement:** Before writing any fields into a slot, the producer must
zero the entire slot. This is required because:
1. The null validity bitmap must start at zero (§10).
2. The same physical slot is reused across ring laps.

A producer may omit zeroing only if it writes every byte of every field on every
record, but zeroing is the safe default.

---

## 12. Heap region — variable-length payloads

The heap region is a circular byte ring used for all heap-backed field types.

```
heap_start = 512 + index_capacity × record_stride
```

**`HEAP_WRITE`** (Atomics index 11) is a monotonically increasing byte counter.
The physical write position within the ring is:

```
phys_cursor = HEAP_WRITE % heap_capacity
```

To claim `N` bytes:
1. Atomically add `N` to `HEAP_WRITE` and capture the old value as `heap_offset`.
2. Compute `phys_offset = heap_offset % heap_capacity`.
3. Write `N` bytes starting at SAB byte `heap_start + phys_offset`.
4. Advance `HEAP_COMMIT` to match `HEAP_WRITE` (§15 step 5).
5. Store `heap_offset` and `N` as the 6-byte pointer in the index record.

**`HEAP_COMMIT`** (Atomics index 12) is the consumer visibility fence for heap data.
Consumers must not read heap bytes beyond `heap_start + (HEAP_COMMIT % heap_capacity)`.
A producer advances `HEAP_COMMIT` after writing all heap payloads for a record batch,
before advancing `COMMIT_SEQ`.

**Ring wrap:** When the remaining space before the physical end of the heap is less
than the payload size, the producer must write a skip sentinel (§13) and continue
from physical offset 0.

---

## 13. Heap skip sentinel

When a payload would extend past `heap_capacity`, the producer writes a skip sentinel
at the current physical position and then writes the payload starting at physical
offset 0.

**Sentinel wire format (6 bytes):**

```
[skip_magic: u16 = 0xFFFF][bytes_to_skip: u32, LE]
```

`bytes_to_skip` = `heap_capacity - phys_cursor` — the number of bytes between the
current physical cursor and the physical end of the heap.

After writing the sentinel:
- Advance `HEAP_WRITE` by `bytes_to_skip`.
- The new `phys_cursor` is 0 (ring origin).
- Write the payload starting at physical offset 0.
- Advance `HEAP_WRITE` by the payload byte count.

**Sentinel detection:** A consumer encountering `0xFFFF` as the first two bytes of a
heap block reads the following `u32` as `bytes_to_skip`, advances its read pointer by
`bytes_to_skip`, and re-reads the payload from the new position.

`0xFF` is not a valid UTF-8 leading byte, so a sentinel can never be confused with the
start of a valid UTF-8 string payload.

**Precondition:** The heap must be large enough to hold the sentinel itself (6 bytes)
before the wrap. If `heap_capacity - phys_cursor < 6`, the producer must first emit
padding bytes to reach a position where 6 bytes are available before the end. In
practice, `heap_capacity` must be at least `max_payload_size + 6` to avoid this edge
case.

---

## 14. Heap alignment for typed arrays

`i32_array` (tag 12) and `f32_array` (tag 13) payloads must start at a **4-byte-aligned**
physical heap offset (`phys_offset % 4 == 0`). Constructing a `Float32Array` or
`Int32Array` view over an unaligned offset throws a `RangeError` in all JS engines.

**Alignment padding procedure (applied before claiming data bytes):**

```
misalign = phys_cursor % 4
if misalign != 0:
    pad = 4 - misalign
    remaining_before_wrap = heap_capacity - phys_cursor
    if pad <= remaining_before_wrap:
        advance HEAP_WRITE by pad      # skip pad bytes; phys_cursor is now aligned
    else:
        # padding itself crosses the ring boundary
        write skip sentinel (§13)      # lands at phys_cursor = 0, which is always aligned
```

**Why phys_offset = 0 is always 4-byte aligned:**

```
heap_start = 512 + index_capacity × record_stride
```

`512` is divisible by 4. `record_stride` is 4-byte aligned (enforced by `buildSchema()`).
`index_capacity` is a power of 2. Therefore `heap_start` is divisible by 4, and
`SAB_byte_address(phys_offset = 0) = heap_start + 0` is 4-byte aligned for `Int32Array`
and `Float32Array`.

---

## 15. Write protocol — step-by-step

This is the sequence a producer follows for each record (or batch of records).
All `Atomics` operations target the `Int32Array` view starting at SAB byte 0.

### Claim phase

```
1. (Backpressure check — see §16.)

2. seq ← Atomics.add(ctrl, WRITE_SEQ, 1)
   # Returns the old value. The producer now owns slot (seq & (index_capacity - 1)).
```

### Write phase

```
3. slot_byte_offset ← 512 + (seq & (index_capacity - 1)) * record_stride

4. Zero the slot:
     memset(SAB + slot_byte_offset, 0, record_stride)

5. For each non-null field in the record:
     a. Fixed-width fields (i32, u32, i64, f32, f64, u16, u8, bool8, utf8_ref):
          Write value at SAB[slot_byte_offset + field.byte_offset], LE.

     b. Heap-backed fields (utf8, json, bytes, i32_array, f32_array):
          i.  Apply alignment padding if required (§14 for i32_array, f32_array).
          ii. heap_offset ← Atomics.add(ctrl, HEAP_WRITE, payload_byte_len)
              phys_offset ← heap_offset % heap_capacity
              remaining   ← heap_capacity - phys_offset
              if payload_byte_len > remaining:
                  write skip sentinel at heap_start + phys_offset (§13)
                  Atomics.add(ctrl, HEAP_WRITE, remaining)
                  heap_offset_final ← Atomics.load(ctrl, HEAP_WRITE)
                  Atomics.add(ctrl, HEAP_WRITE, payload_byte_len)
                  phys_offset ← 0
              else:
                  heap_offset_final ← heap_offset
          iii. Write payload_byte_len bytes at SAB[heap_start + phys_offset].
          iv.  Write [heap_offset_final: u32, LE][payload_byte_len: u16, LE]
               at SAB[slot_byte_offset + field.byte_offset].

     c. Nullable fields:
          For each nullable field written (value present), set its validity bit (§10).
          Omitted nullable fields: leave bit 0, leave field bytes zeroed.

6. Advance heap commit fence:
     Atomics.store(ctrl, HEAP_COMMIT, Atomics.load(ctrl, HEAP_WRITE))
   # Must happen before COMMIT_SEQ is advanced.

7. Advance commit fence:
     Atomics.add(ctrl, COMMIT_SEQ, 1)
   # The record is now visible to consumers.

8. Wake consumers:
     Atomics.notify(ctrl, COMMIT_SEQ, +∞)
```

**Batch writes:** For a batch of N records, the producer may claim all N slots at once
(`Atomics.add(ctrl, WRITE_SEQ, N)`) and commit them one-by-one as they are written, or
commit the entire batch with `Atomics.add(ctrl, COMMIT_SEQ, N)` after writing all N. The
second approach has lower `Atomics.notify` overhead but delays consumer visibility until
the whole batch is written.

**Ordering invariant:** `COMMIT_SEQ` must never exceed `WRITE_SEQ`. A consumer reading
`COMMIT_SEQ = K` is guaranteed that records 0 through K-1 are fully written.

---

## 16. Backpressure

The ring holds at most `index_capacity` records that have been committed but not yet
acknowledged by the consumer. When the ring is full, the producer must block.

**Effective read cursor:**

```
if any CONSUMER_SLOT[i] != 0x7FFFFFFF:
    effective_read ← min(CONSUMER_SLOT[i] for all occupied slots)
else:
    effective_read ← Atomics.load(ctrl, READ_CURSOR)
```

**Full condition (check before claiming a slot):**

```
write_seq = Atomics.load(ctrl, WRITE_SEQ)
if (write_seq - effective_read) >= index_capacity:
    # Ring is full. Block until consumer advances its cursor.
    Atomics.wait(ctrl, READ_CURSOR, current_read_cursor)
    # Re-check after wake-up; may be spurious.
```

The consumer advances `READ_CURSOR` by calling `acknowledgeRead(n)`, which sets
`READ_CURSOR` to `n` and calls `Atomics.notify(ctrl, READ_CURSOR, 1)`.

**Critical consumer requirement:**

> `acknowledgeRead()` **must be called in the drain loop, unconditionally, for every
> record consumed** — regardless of whether the record was filtered or skipped. The ring
> only advances when the read cursor advances. Failure to acknowledge read records will
> stall the producer once the ring fills.
>
> Example pattern:
>
> ```
> let seq = 0;
> while (true) {
>   const count = await view.waitForCommit(seq);
>   for (; seq < count; seq++) {
>     cursor.seek(seq);
>     if (passes_filter(cursor)) render(cursor);
>     // ← do NOT skip acknowledgeRead for filtered records
>   }
>   view.acknowledgeRead(count);   // ← must happen for every record
>   if (view.status === 'eos') break;
> }
> ```
>
> If total committed records exceed `index_capacity`, deferring `acknowledgeRead()`
> outside the loop will deadlock: the producer blocks on a full ring while the consumer
> is stuck in `await waitForCommit()`.

---

## 17. Lifecycle state machine

`CTRL_STATUS` (Int32Array index 10) encodes the stream lifecycle.

| Value | Name            | Meaning                                                        |
|-------|-----------------|----------------------------------------------------------------|
| 0     | `INITIALIZING`  | SAB allocated, header written. Producer not yet writing.       |
| 1     | `STREAMING`     | `begin()` called. Records are flowing.                         |
| 2     | `EOS`           | `finalize()` called. All records committed. No more writes.    |
| 3     | `ERROR`         | `abort()` called or fatal error. Heap may be partial.          |

**Transitions:**

```
INITIALIZING → STREAMING   via begin():    Atomics.store(STATUS, 1); Atomics.notify(STATUS, +∞)
STREAMING    → EOS         via finalize(): Atomics.store(STATUS, 2); Atomics.notify(STATUS, +∞)
STREAMING    → ERROR       via abort():    Atomics.store(STATUS, 3); Atomics.notify(STATUS, +∞)
```

A consumer polling `STATUS` should use `Atomics.load` and call `Atomics.waitAsync` on
`CTRL_COMMIT_SEQ` or `CTRL_STATUS` to sleep without spinning.

---

## 18. Abort protocol

Either side may abort the stream.

**Consumer-initiated abort:**
1. Consumer sets `CTRL_ABORT = 1` via `Atomics.store`.
2. Consumer wakes the producer: `Atomics.notify(ctrl, CTRL_WRITE_SEQ, 1)`.
3. Producer checks `Atomics.load(ctrl, CTRL_ABORT)` after each batch write.
4. If `CTRL_ABORT == 1`, producer stops writing and calls `abort()`:
   `Atomics.store(STATUS, 3); Atomics.notify(STATUS, +∞)`.

**Producer-initiated abort:**
1. Producer encounters an error and calls `abort()` directly:
   `Atomics.store(STATUS, 3); Atomics.notify(STATUS, +∞)`.
2. Consumer sees `status === 'error'` and stops consuming.

After abort, the ring is in an undefined state. A fresh stream requires re-initializing
the header or using the `reset()` protocol (rewind all cursors to zero; static header
fields are preserved).

---

## 19. Validation on attach

A producer or consumer attaching to an existing SAB must validate the header before
using any geometry values. Validation order:

1. **Size:** `sab.byteLength >= 512`. A smaller buffer cannot hold the header.
2. **Magic:** bytes 0–3 as u32 LE == `0x5354524E`. Rejects non-Strand buffers.
3. **Version:** bytes 4–7 as u32 LE == `3`. Rejects buffers written by other versions.
4. **Header CRC:** recompute FNV-1a of bytes 0–23 and compare to bytes 24–27. Rejects
   corrupted geometry fields.
5. **Schema byte len:** bytes 88–91 as u32 LE. Must be `>= 2` (minimum: 2-byte
   field_count) and `<= 420`.
6. **Schema decode:** parse the binary schema encoding (§6) from bytes 92 through
   `92 + schema_byte_len`. Reject if truncated or contains unknown type tags.
7. **Schema fingerprint:** recompute FNV-1a of the schema bytes and compare to
   bytes 8–11. Rejects schema descriptor corruption.
8. **Stride coherence:** recompute `record_stride` from field layout (high-water mark
   of `byte_offset + field_width`, padded to 4 bytes) and compare to bytes 12–15.
   A mismatch means a producer using the wrong stride would silently alias record slots.

---

## 20. Magic and version constants

```
STRAND_MAGIC    = 0x5354524E   ('STRN' in little-endian ASCII)
STRAND_VERSION  = 3
HEADER_SIZE     = 512
INDEX_START     = 512
MAX_SCHEMA_BYTES = 420         (512 − 92)
HEAP_SKIP_MAGIC = 0xFFFF
HEAP_SKIP_SIZE  = 6
CONSUMER_SLOT_VACANT = 0x7FFFFFFF
```

Status values:
```
STATUS_INITIALIZING = 0
STATUS_STREAMING    = 1
STATUS_EOS          = 2
STATUS_ERROR        = 3
```

Atomics control word Int32Array indices:
```
CTRL_WRITE_SEQ   = 7
CTRL_COMMIT_SEQ  = 8
CTRL_READ_CURSOR = 9
CTRL_STATUS      = 10
CTRL_HEAP_WRITE  = 11
CTRL_HEAP_COMMIT = 12
CTRL_ABORT       = 13
CTRL_CONSUMER_BASE = 14   (slots 14–21, 8 slots total)
```
