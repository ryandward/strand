/**
 * @strand/core — bitset primitives
 *
 * Uint32Array bitsets for vectorized constraint evaluation over the Strand ring
 * buffer. Each bit j represents the record at logical index j within the active
 * window (j = seq - windowStart).
 *
 * Bit layout:
 *   word  = j >>> 5        (Math.floor(j / 32))
 *   shift = j  &  31       (j % 32)
 *   set:   bs[word] |= (1 << shift)
 *   test:  bs[word] &  (1 << shift)
 *
 * All operations are O(N / 32) where N = window size in records.
 */

// ── Filter predicate ──────────────────────────────────────────────────────────

/**
 * Predicate describing the values a field must hold for a record to pass.
 *
 * between  Inclusive numeric range [lo, hi]. Works on any numeric FieldType
 *          that is not heap-indirected (i32, u32, f32, f64, u16, u8, bool8).
 *
 * eq       Exact numeric equality. Useful for u8/u16/bool8/utf8_ref (single handle).
 *
 * in       Handle-set membership. Designed for utf8_ref fields: each value is
 *          stored as a u32 intern-table handle; pass the set of matching handles.
 *          Also works for any numeric type when multiple discrete values are needed.
 */
export type FilterPredicate =
  | { kind: 'between'; lo: number; hi: number }
  | { kind: 'eq';      value: number }
  | { kind: 'in';      handles: ReadonlySet<number> };

// ── Bitset construction ───────────────────────────────────────────────────────

/**
 * Allocate a zeroed bitset large enough to hold `bitCount` bits.
 * Bit j is at word (j >>> 5), shift (j & 31).
 */
export function createBitset(bitCount: number): Uint32Array {
  return new Uint32Array(Math.ceil(bitCount / 32));
}

// ── Intersection ─────────────────────────────────────────────────────────────

/**
 * Return a new bitset that is the bitwise AND of all inputs.
 *
 * All inputs must have the same `.length` (built from the same committed
 * snapshot — same windowStart, same committedCount). Mismatched lengths
 * are truncated to the shortest input.
 *
 * Time complexity: O(N / 32) where N = bits in the shortest input.
 * Returns an empty Uint32Array when `bitsets` is empty.
 */
export function computeIntersection(bitsets: readonly Uint32Array[]): Uint32Array {
  if (bitsets.length === 0) return new Uint32Array(0);

  // Copy the first bitset so we never mutate a caller-owned buffer.
  const out = bitsets[0]!.slice();
  const len = out.length;

  for (let i = 1; i < bitsets.length; i++) {
    const bs = bitsets[i]!;
    // Intersect word-by-word; stop at shortest length.
    const words = Math.min(len, bs.length);
    for (let w = 0; w < words; w++) {
      out[w] = out[w]! & bs[w]!;
    }
    // Zero remaining words if `bs` is shorter than `out`.
    for (let w = words; w < len; w++) {
      out[w] = 0;
    }
  }

  return out;
}

// ── Population count ─────────────────────────────────────────────────────────

/**
 * Count set bits in `bs`, considering only bits 0..(limit-1).
 * If `limit` is omitted, all bits in the array are counted.
 *
 * Uses the Hamming-weight algorithm (parallel bit summation) for O(N/32)
 * throughput with a mask applied to the final partial word.
 */
export function popcount(bs: Uint32Array, limit?: number): number {
  const effectiveLimit = limit ?? bs.length * 32;
  const fullWords      = effectiveLimit >>> 5; // Math.floor(effectiveLimit / 32)
  const tailBits       = effectiveLimit  &  31; // effectiveLimit % 32

  let count = 0;

  const bulk = Math.min(fullWords, bs.length);
  for (let w = 0; w < bulk; w++) {
    count += popcountWord(bs[w]!);
  }

  if (tailBits > 0 && fullWords < bs.length) {
    // Mask off bits beyond `limit` in the partial last word.
    const mask = (1 << tailBits) - 1;
    count += popcountWord(bs[fullWords]! & mask);
  }

  return count;
}

/** Hamming weight of a single unsigned 32-bit word (parallel bit summation). */
function popcountWord(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// ── Iteration ────────────────────────────────────────────────────────────────

/**
 * Invoke `fn` for each set bit j in `bs`, where j < limit.
 *
 * Bits are visited in ascending order (ascending logical seq order).
 *
 * Hot-loop strategy:
 *   - Zero words are skipped with a single `if (word === 0) continue` — O(1).
 *   - Within each non-zero word, `word & -word` isolates the lowest set bit in
 *     O(1); `Math.clz32` converts it to a 0-based bit position in O(1).
 *     `word &= word - 1` clears it in O(1). Total work = O(popcount(word)).
 *
 * @param bs     The bitset to iterate.
 * @param limit  Only consider bits 0..(limit-1). Typically = windowSize.
 * @param fn     Callback receiving the logical bit index j (= seq - windowStart).
 */
export function forEachSet(
  bs:    Uint32Array,
  limit: number,
  fn:    (j: number) => void,
): void {
  const wordCount = Math.ceil(limit / 32);
  const lastWord  = wordCount - 1;

  for (let w = 0; w < wordCount && w < bs.length; w++) {
    let word: number = bs[w]!;

    // Mask off bits beyond `limit` in the final word so we never visit
    // bits that were never set by getFilterBitset.
    if (w === lastWord) {
      const tail = limit & 31;
      if (tail !== 0) word &= (1 << tail) - 1;
    }

    if (word === 0) continue; // skip zero words in O(1)

    const base = w << 5; // w * 32

    // Drain all set bits in this word using lowest-set-bit isolation.
    while (word !== 0) {
      // Isolate the lowest set bit.
      const lsb = word & -word;
      // Math.clz32 counts leading zeros; for a power-of-two lsb,
      // position = 31 - clz32(lsb).
      const pos = 31 - Math.clz32(lsb);
      fn(base + pos);
      // Clear the lowest set bit.
      word &= word - 1;
    }
  }
}
