/**
 * Join Solid class values into a single class string. Solid accepts strings,
 * arrays, and `{ "class-name": boolean }` records, so design-system components
 * merge their own base classes with whatever the caller passed without caring
 * which form it took.
 */
export type ClassValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<ClassValue>
  | Readonly<Record<string, boolean | undefined>>

export function classNames(...values: ClassValue[]): string {
  const out: string[] = []
  for (const value of values) {
    if (typeof value === "string" || typeof value === "number") {
      out.push(String(value))
      continue
    }
    if (Array.isArray(value)) {
      const nested = classNames(...value)
      if (nested !== "") out.push(nested)
      continue
    }
    if (value !== null && typeof value === "object") {
      for (const [name, active] of Object.entries(value)) {
        if (active === true) out.push(name)
      }
    }
  }
  return out.join(" ")
}
