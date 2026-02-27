/**
 * @strand/core — binary schema encoding, decoding, fingerprinting
 *
 * The schema is stored in binary form in the Strand header. The FNV-1a
 * fingerprint of this binary encoding is schema_fingerprint. A reader
 * validates the fingerprint on attach — type mismatch fails fast before
 * any data access is attempted.
 *
 * Wire format for the binary schema descriptor (all values little-endian):
 *
 *   [field_count: u16]
 *   For each field (variable length, padded to 4-byte boundary):
 *     [type_tag:    u8]
 *     [flags:       u8]
 *     [byte_offset: u16]  ← explicit; no alignment guessing on decode
 *     [name_len:    u8]
 *     [name_bytes:  name_len × u8, UTF-8]
 *     [padding:     0–3 zero bytes to next 4-byte boundary]
 */

import {
  FIELD_BYTE_WIDTHS,
  FIELD_FLAG_NULLABLE,
  type FieldDescriptor,
  type BinarySchemaDescriptor,
  type FieldType,
} from './types';

// ─── Type Tag Mappings ────────────────────────────────────────────────────────

const TYPE_TO_TAG: Readonly<Record<FieldType, number>> = {
  i32: 0, u32: 1, i64: 2, f32: 3, f64: 4,
  u16: 5, u8:  6, bool8: 7, utf8: 8, utf8_ref: 9, json: 10,
};

const TAG_TO_TYPE: Readonly<Record<number, FieldType>> = {
  0: 'i32', 1: 'u32', 2: 'i64', 3: 'f32', 4: 'f64',
  5: 'u16', 6: 'u8',  7: 'bool8', 8: 'utf8', 9: 'utf8_ref', 10: 'json',
};

// ─── FNV-1a 32-bit ────────────────────────────────────────────────────────────

/**
 * FNV-1a 32-bit hash.
 * Math.imul() is a native 32-bit integer multiply — avoids float precision loss
 * that would occur with the plain * operator on large numbers.
 */
function fnv1a32(bytes: Uint8Array): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (const byte of bytes) {
    hash ^= byte;
    hash  = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0; // coerce to u32
}

// ─── Encoding ─────────────────────────────────────────────────────────────────

/**
 * Encode a BinarySchemaDescriptor to bytes for storage in the header.
 * This encoding is the canonical input to schemaFingerprint().
 */
export function encodeSchema(schema: BinarySchemaDescriptor): Uint8Array {
  const encoder     = new TextEncoder();
  const fieldBufs:  Uint8Array[] = [];
  let   totalLen    = 2; // field_count u16

  for (const field of schema.fields) {
    const nameBytes = encoder.encode(field.name);
    // header: type(1) + flags(1) + byteOffset(2) + nameLen(1) + name(nameLen)
    const rawLen    = 5 + nameBytes.length;
    const paddedLen = Math.ceil(rawLen / 4) * 4;
    const buf       = new Uint8Array(paddedLen); // zero-filled
    const dv        = new DataView(buf.buffer);

    buf[0] = TYPE_TO_TAG[field.type]!;
    buf[1] = field.flags;
    dv.setUint16(2, field.byteOffset, /* littleEndian */ true);
    buf[4] = nameBytes.length;
    buf.set(nameBytes, 5);
    // Trailing bytes remain zero-padding.

    fieldBufs.push(buf);
    totalLen += paddedLen;
  }

  const out = new Uint8Array(totalLen);
  new DataView(out.buffer).setUint16(0, schema.fields.length, true);

  let cursor = 2;
  for (const fb of fieldBufs) {
    out.set(fb, cursor);
    cursor += fb.length;
  }

  return out;
}

// ─── Decoding ─────────────────────────────────────────────────────────────────

/**
 * Decode a binary schema descriptor read from the header.
 * Returns null if the bytes are truncated or contain an unknown type tag.
 */
export function decodeSchema(bytes: Uint8Array): BinarySchemaDescriptor | null {
  if (bytes.length < 2) return null;

  const decoder    = new TextDecoder();
  const dv         = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fieldCount = dv.getUint16(0, true);
  const fields:    FieldDescriptor[] = [];
  let   cursor     = 2;
  let   nullableBitIdx = 0;

  for (let i = 0; i < fieldCount; i++) {
    if (cursor + 5 > bytes.length) return null; // truncated

    const typeTag    = bytes[cursor]!;
    const flags      = bytes[cursor + 1]!;
    const byteOffset = dv.getUint16(cursor + 2, true);
    const nameLen    = bytes[cursor + 4]!;
    const type       = TAG_TO_TYPE[typeTag];

    if (type === undefined) return null; // unknown type tag — corrupt or newer version
    if (cursor + 5 + nameLen > bytes.length) return null;

    const name      = decoder.decode(bytes.subarray(cursor + 5, cursor + 5 + nameLen));
    const rawLen    = 5 + nameLen;
    const paddedLen = Math.ceil(rawLen / 4) * 4;

    const fd: FieldDescriptor = (flags & FIELD_FLAG_NULLABLE)
      ? { name, type, byteOffset, flags, nullableBitIndex: nullableBitIdx++ }
      : { name, type, byteOffset, flags };
    fields.push(fd);
    cursor += paddedLen;
  }

  // Recompute record_stride from field layout — the highest (byteOffset + width) + alignment.
  let highWater = 0;
  for (const f of fields) {
    highWater = Math.max(highWater, f.byteOffset + FIELD_BYTE_WIDTHS[f.type]);
  }
  const record_stride = Math.ceil(highWater / 4) * 4;

  return { fields, record_stride };
}

// ─── Fingerprint ──────────────────────────────────────────────────────────────

/**
 * Compute the FNV-1a 32-bit fingerprint of a BinarySchemaDescriptor.
 * Two schemas with identical field names, types, offsets, and flags
 * produce the same fingerprint. Any difference produces a different one.
 */
export function schemaFingerprint(schema: BinarySchemaDescriptor): number {
  return fnv1a32(encodeSchema(schema));
}

// ─── Schema Builder ───────────────────────────────────────────────────────────

/**
 * Build a BinarySchemaDescriptor from a list of field definitions.
 *
 * Fields are laid out in declaration order. Each field is aligned to
 * min(fieldWidth, 4) bytes. The final stride is padded to a 4-byte boundary.
 *
 * Usage:
 *   const schema = buildSchema([
 *     { name: 'chrom_id',  type: 'utf8_ref' },
 *     { name: 'pos',       type: 'i64',  flags: FIELD_FLAG_SORTED_ASC },
 *     { name: 'qual',      type: 'f32' },
 *     { name: 'sequence',  type: 'utf8' },
 *   ]);
 */
export function buildSchema(
  fields: ReadonlyArray<{ name: string; type: FieldType; flags?: number }>,
): BinarySchemaDescriptor {
  if (fields.length === 0) {
    throw new TypeError(
      'buildSchema: schema must declare at least one field. ' +
      'A zero-field schema produces record_stride = 0, which breaks ring arithmetic.',
    );
  }

  const seen = new Set<string>();
  const resolved: FieldDescriptor[] = [];

  // Reserve null validity bitmap bytes at the very start of each record slot.
  // One bit per nullable field (FIELD_FLAG_NULLABLE). Bitmap size is
  // Math.ceil(nullableCount / 8) bytes; zero if no nullable fields exist.
  const nullableCount = fields.filter(f => f.flags && (f.flags & FIELD_FLAG_NULLABLE)).length;
  const bitmapBytes   = nullableCount > 0 ? Math.ceil(nullableCount / 8) : 0;

  let offset         = bitmapBytes; // fields start after the bitmap
  let nullableBitIdx = 0;

  for (const f of fields) {
    if (seen.has(f.name)) {
      throw new TypeError(
        `buildSchema: duplicate field name '${f.name}'. ` +
        `All field names must be unique within a schema.`,
      );
    }
    seen.add(f.name);

    const width     = FIELD_BYTE_WIDTHS[f.type];
    const alignment = Math.min(width, 4);

    // Align field to its natural boundary (within the slot, after bitmap bytes).
    const rem = offset % alignment;
    if (rem !== 0) offset += alignment - rem;

    const flags = f.flags ?? 0;
    const fd: FieldDescriptor = (flags & FIELD_FLAG_NULLABLE)
      ? { name: f.name, type: f.type, byteOffset: offset, flags, nullableBitIndex: nullableBitIdx++ }
      : { name: f.name, type: f.type, byteOffset: offset, flags };
    resolved.push(fd);
    offset += width;
  }

  const record_stride = Math.ceil(offset / 4) * 4;
  return { fields: resolved, record_stride };
}
