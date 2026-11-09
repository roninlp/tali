import { Schema } from 'effect'

/**
 * A mirrored field that reaches the client in one of two encodings.
 *
 * A local write stores the value itself; the API stores the same field as JSON
 * text. Decoding tries the value first, then the JSON-text encoding, so one
 * schema covers both paths and no caller has to inspect the representation.
 */
export const JsonField = <S extends Schema.Constraint>(schema: S) =>
  Schema.Union([schema, Schema.fromJsonString(schema)])
