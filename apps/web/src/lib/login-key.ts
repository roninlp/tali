import { argon2idAsync } from "@noble/hashes/argon2.js"
import {
  base64UrlEncode,
  deriveKdfSalt,
  KDF_PARAMS,
  PASSWORD_MIN_LENGTH,
  type LoginKey
} from "@tali/domain"

/**
 * Client-side credential derivation (ADR-0001).
 *
 * The password is stretched in the browser with argon2id (19 MiB, t=2, p=1)
 * and only the resulting 32-byte **login key** is sent to the API. The salt is
 * deterministic — `SHA-256("tali:kdf:v1:" + normalizeEmail(email))` — so login
 * needs no request that could reveal whether an account exists.
 *
 * This is the one seam every password entry point uses (login, registration,
 * and changing the credential), so the recipe cannot drift between forms.
 */
export const deriveLoginKey = async (password: string, email: string): Promise<LoginKey> => {
  const salt = await deriveKdfSalt(email)
  const key = await argon2idAsync(password, salt, KDF_PARAMS)
  return base64UrlEncode(key) as LoginKey
}

/** The browser enforces the password policy; the API never sees a password. */
export const passwordProblem = (password: string): string | undefined =>
  password.length < PASSWORD_MIN_LENGTH ? "گذرواژه باید حداقل ۱۲ نویسه باشد." : undefined
