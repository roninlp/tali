import { describe, expect, it } from "vitest"
import { urlBase64ToUint8Array } from "./config"

describe("urlBase64ToUint8Array", () => {
  it("decodes unpadded base64", () => {
    expect([...urlBase64ToUint8Array("AQID")]).toEqual([1, 2, 3])
  })

  it("handles url-safe characters", () => {
    expect([...urlBase64ToUint8Array("-_8")]).toEqual([0xfb, 0xff])
  })

  it("decodes a VAPID key to an uncompressed P-256 point", () => {
    // The public half of the pair generated for the local test-push harness.
    const key = "BGY9jCGmtvj4rGgzFTVWiAEOo-w4yil14BtLctF0hue2dRAd5Da6FYJaoQzBc37EgeBptqsloga-ILzpO9aLOiA"
    const bytes = urlBase64ToUint8Array(key)
    expect(bytes).toHaveLength(65)
    expect(bytes[0]).toBe(4)
  })
})
