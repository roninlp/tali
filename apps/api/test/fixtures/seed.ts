import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { uuidV7, type Digits, type WeekStart } from '@tali/domain'

/**
 * The raw-SQL identity seeds the HTTP/RPC suites share. They write the rows
 * exactly as the auth service does, with the same Persian-first defaults:
 * Tehran, Saturday week start, Persian digits, and the email as display name
 * unless a suite overrides it.
 */

const DEFAULT_TIME_ZONE = 'Asia/Tehran'
const DEFAULT_WEEK_START: WeekStart = 'saturday'
const DEFAULT_DIGITS: Digits = 'persian'

export interface SeedUserInput {
  readonly id: string
  readonly email: string
  readonly timeZone?: string
  readonly weekStart?: WeekStart
  readonly digits?: Digits
  readonly displayName?: string
  readonly now?: string
}

export const seedUser = (db: DatabaseSync, input: SeedUserInput): void => {
  const now = input.now ?? new Date().toISOString()
  db.prepare(
    `INSERT INTO users
      (id, email, credential_verifier, credential_salt, kdf_version,
       display_name, time_zone, week_start, digits, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.email,
    '0'.repeat(64),
    '0'.repeat(32),
    input.displayName ?? input.email,
    input.timeZone ?? DEFAULT_TIME_ZONE,
    input.weekStart ?? DEFAULT_WEEK_START,
    input.digits ?? DEFAULT_DIGITS,
    now,
    now,
  )
}

export interface SeedSessionOptions {
  readonly now?: string
  readonly expiresAt?: string
}

export const seedSession = (
  db: DatabaseSync,
  userId: string,
  token: string,
  options: SeedSessionOptions = {},
): void => {
  const now = options.now ?? new Date().toISOString()
  const expiresAt =
    options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString()
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(uuidV7(), userId, sha256(token), expiresAt, now)
}

export interface SeedHouseholdInput {
  readonly id: string
  readonly creator: string
  readonly inviteCode: string
  readonly name?: string
  readonly now?: string
}

export const seedHousehold = (
  db: DatabaseSync,
  input: SeedHouseholdInput,
): void => {
  const now = input.now ?? new Date().toISOString()
  db.prepare(
    `INSERT INTO households (id, name, invite_code, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.name ?? input.inviteCode,
    input.inviteCode,
    input.creator,
    now,
  )
}

export type MembershipRole = 'owner' | 'member'

export interface SeedMembershipOptions {
  readonly role?: MembershipRole
  readonly now?: string
}

export const seedMembership = (
  db: DatabaseSync,
  userId: string,
  householdId: string,
  options: SeedMembershipOptions = {},
): void => {
  const now = options.now ?? new Date().toISOString()
  db.prepare(
    `INSERT INTO memberships (id, household_id, user_id, role, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(uuidV7(), householdId, userId, options.role ?? 'owner', now)
}

/** The session token hash the auth service looks up. */
const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex')
