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

export const PushSubscriptionId = Schema.String.pipe(Schema.brand("PushSubscriptionId"))
export type PushSubscriptionId = Schema.Schema.Type<typeof PushSubscriptionId>

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

const EMAIL_PATTERN = /^\s*[^\s@]+@[^\s@]+\.[^\s@]+\s*$/

/** Email address: format-checked at the schema edge, canonicalized by `normalizeEmail`. */
export const Email = Schema.String.check(Schema.isPattern(EMAIL_PATTERN)).pipe(
  Schema.brand("Email")
)
export type Email = Schema.Schema.Type<typeof Email>

/**
 * Canonical stored/looked-up form of an email. Schema validation guarantees the
 * shape; this only lower-cases and trims so two spellings map to one row.
 */
export const normalizeEmail = (raw: string): Email => raw.trim().toLowerCase() as Email

/** Opaque invite secret the second user presents to join a household. */
export const InviteCode = Schema.String.pipe(Schema.brand("InviteCode"))
export type InviteCode = Schema.Schema.Type<typeof InviteCode>
