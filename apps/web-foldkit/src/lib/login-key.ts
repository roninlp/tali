import { argon2idAsync } from '@noble/hashes/argon2.js'
import {
  KDF_PARAMS,
  LoginKey,
  PASSWORD_MIN_LENGTH,
  base64UrlEncode,
  deriveKdfSalt,
} from '@tali/domain'

/**
 * Client-side credential derivation (ADR-0001), ported from
 * `apps/web/src/lib/login-key.ts`.
 *
 * The password is stretched in the browser with argon2id (19 MiB, t=2, p=1)
 * and only the resulting 32-byte login key is sent to the API. The salt is
 * deterministic, so login needs no request that could reveal whether an
 * account exists.
 */
export const deriveLoginKey = async (
  password: string,
  email: string,
): Promise<LoginKey> => {
  const salt = await deriveKdfSalt(email)
  const key = await argon2idAsync(password, salt, KDF_PARAMS)

  return LoginKey.make(base64UrlEncode(key))
}

/** The browser enforces the password policy; the API never sees a password. */
export const passwordProblem = (password: string): string | undefined =>
  password.length < PASSWORD_MIN_LENGTH
    ? 'گذرواژه باید حداقل ۱۲ نویسه باشد.'
    : undefined
