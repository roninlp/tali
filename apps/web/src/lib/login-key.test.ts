import { describe, expect, it } from "vitest"
import { deriveKdfSalt, KDF_PARAMS } from "@tali/domain"
import { deriveLoginKey, passwordProblem } from "./login-key"

/**
 * The client-side KDF is the credential (ADR-0001): the same password and
 * email must always produce the same 32-byte login key, or an account could
 * never log in again.
 */
describe("login key derivation", () => {
  it("is deterministic for the same normalized email and password", async () => {
    const first = await deriveLoginKey("correct horse battery", "owner@example.com")
    const second = await deriveLoginKey("correct horse battery", " Owner@Example.COM ")
    expect(second).toBe(first)
  })

  it("produces an unpadded base64url encoding of 32 bytes", async () => {
    const key = await deriveLoginKey("correct horse battery", "owner@example.com")
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("differs when the password changes", async () => {
    const a = await deriveLoginKey("correct horse battery", "owner@example.com")
    const b = await deriveLoginKey("correct horse batterY", "owner@example.com")
    expect(a).not.toBe(b)
  })

  it("uses the agreed argon2id cost and deterministic salt", async () => {
    expect(KDF_PARAMS).toEqual({ m: 19_456, t: 2, p: 1, dkLen: 32 })
    const salt = await deriveKdfSalt("owner@example.com")
    const same = await deriveKdfSalt(" OWNER@example.com ")
    expect(salt).toHaveLength(32)
    expect([...same]).toEqual([...salt])
  })

  it("enforces the 12-character minimum in the browser", () => {
    expect(passwordProblem("12345678901")).toBeDefined()
    expect(passwordProblem("123456789012")).toBeUndefined()
  })
})
