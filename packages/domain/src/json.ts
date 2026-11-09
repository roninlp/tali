import { Schema } from 'effect'

/**
 * A JSON object from a trust boundary: a model tool call, a database JSON
 * column, or a sync patch.
 *
 * Decoding accepts only a non-null, non-array object, which is the exact
 * contract the hand-written `asRecord` / `isRecord` / `typeof === 'object'`
 * guards repeated across the workspace. Use `Schema.decodeUnknownOption` (or
 * `decodeOption`) with this schema at the boundary, then decode the fields you
 * need with their real domain schema.
 */
export const JsonRecord = Schema.Record(Schema.String, Schema.Json)

export type JsonRecord = typeof JsonRecord.Type
