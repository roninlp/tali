import { Schema } from 'effect'

/**
 * Schema primitives shared across the app for numbers whose domain excludes
 * `NaN` and the infinities.
 */

/** Monotonic millisecond timestamps; never NaN/Infinity. */
export const TimestampMillis = Schema.Finite
