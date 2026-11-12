/**
 * Patch-derived "did this write change anything?" comparison.
 *
 * Every `update` path builds the next row from a patch and then has to decide
 * whether the request is a no-op, so an idempotent save returns the current row
 * instead of minting a version. That decision used to be a hand-written field
 * list per aggregate, which silently drops edits the moment a field is added to
 * the patch schema but forgotten in the list: the client is told the save
 * succeeded while the new value is never written.
 *
 * Comparing the fields *the caller actually sent* removes that class of bug. A
 * new patch field is compared for free, because the patch is the list.
 */

/** Deep, order-insensitive equality for the plain JSON-shaped values in a patch. */
const sameValue = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => sameValue(value, b[index]))
    )
  }
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  )
    return false
  // Structs arrive from the client and from the schema decoder, so compare the
  // union of keys: key order is not meaningful, and an absent key reads as
  // `undefined` (which `null` is not).
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  return Object.keys({ ...left, ...right }).every(key =>
    sameValue(left[key], right[key]),
  )
}

/**
 * True when every field the caller actually sent still has its current value.
 * Only keys present in `patch` are compared: an omitted field means "keep it",
 * and a derived field (plainText from body, frequencyHistory from frequency)
 * is implied by the field that produces it.
 */
export const unchangedExcept = <A extends object, P extends object>(
  current: A,
  next: A,
  patch: P,
): boolean => {
  const before = current as Record<string, unknown>
  const after = next as Record<string, unknown>
  return Object.keys(patch).every(key => sameValue(before[key], after[key]))
}
