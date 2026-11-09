import { Schema } from 'effect'

/**
 * The household fields the onboarding screen renders.
 *
 * This is a local plain schema rather than the domain `Household` class. The
 * API response is decoded by the app's own Schema runtime, so no branded value
 * crosses the module boundary Vite's dev optimizer creates for
 * `effect/schema`.
 */
export const HouseholdSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  inviteCode: Schema.String,
})

export type HouseholdSummary = typeof HouseholdSummary.Type
