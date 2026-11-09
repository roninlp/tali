import { Schema } from 'effect'

/**
 * The session as the app Model holds it.
 *
 * `SessionContext` carries branded ids for the wire. The Model only needs the
 * public profile and the household id, and storing them as plain strings keeps
 * a value decoded by the API module from being re-validated against a second
 * copy of the brand schemas in the browser.
 */
export const Session = Schema.Struct({
  user: Schema.Struct({
    id: Schema.String,
    email: Schema.String,
    displayName: Schema.String,
    timeZone: Schema.String,
    weekStart: Schema.String,
    digits: Schema.String,
  }),
  householdId: Schema.NullOr(Schema.String),
})

export type Session = typeof Session.Type
