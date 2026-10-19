import { Schema } from "effect"

/**
 * The one error body every plain-HTTP endpoint returns (see
 * `docs/error-model-draft.md` §5.1). RPC failures ride the Effect envelope
 * instead; this shape exists only where an error must become an HTTP status.
 *
 * `code` is a stable, client-facing string (never a localized message):
 * clients switch on it, and localize with their own copy. `details` carries
 * machine-readable parameters for that code.
 */
export const ErrorEnvelope = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
    details: Schema.Record(Schema.String, Schema.Unknown)
  })
})
export type ErrorEnvelope = Schema.Schema.Type<typeof ErrorEnvelope>
