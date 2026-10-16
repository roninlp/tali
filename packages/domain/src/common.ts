import { Schema } from "effect"

/**
 * Shared building blocks for the Tali domain model (see
 * `docs/domain-model-draft.md` §2).
 *
 * IDs are **UUID v7** strings — time-ordered and client-mintable, so offline
 * writes can create rows before the server sees them (settled in #7). Each
 * aggregate gets a nominal brand so the compiler forbids cross-assignment.
 */

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = Schema.Schema.Type<typeof UserId>

export const HouseholdId = Schema.String.pipe(Schema.brand("HouseholdId"))
export type HouseholdId = Schema.Schema.Type<typeof HouseholdId>

export const MembershipId = Schema.String.pipe(Schema.brand("MembershipId"))
export type MembershipId = Schema.Schema.Type<typeof MembershipId>

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = Schema.Schema.Type<typeof SessionId>

/** First day of the week; Saturday is the Persian-calendar default. */
export const WeekStart = Schema.Literals(["saturday", "sunday", "monday"])
export type WeekStart = Schema.Schema.Type<typeof WeekStart>

/** Numeral rendering preference: Persian digits by default (CC-04). */
export const Digits = Schema.Literals(["persian", "latin"])
export type Digits = Schema.Schema.Type<typeof Digits>

/** Per-item visibility. Two known users in one household — no finer ACL needed. */
export const Visibility = Schema.Literals(["private", "shared"])
export type Visibility = Schema.Schema.Type<typeof Visibility>

/** Household membership role; the first user is the `owner`, the second a `member`. */
export const MembershipRole = Schema.Literals(["owner", "member"])
export type MembershipRole = Schema.Schema.Type<typeof MembershipRole>
