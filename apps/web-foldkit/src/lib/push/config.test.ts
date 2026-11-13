import { describe, expect, test } from 'vite-plus/test'

import { urlBase64ToUint8Array } from './config'

describe('urlBase64ToUint8Array', () => {
  test('decodes unpadded base64', () => {
    expect(Array.from(urlBase64ToUint8Array('AQID'))).toStrictEqual([1, 2, 3])
  })

  test('handles url-safe characters', () => {
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toStrictEqual([0xfb, 0xff])
  })

  test('decodes a VAPID key to an uncompressed P-256 point', () => {
    const key =
      'BGY9jCGmtvj4rGgzFTVWiAEOo-w4yil14BtLctF0hue2dRAd5Da6FYJaoQzBc37EgeBptqsloga-ILzpO9aLOiA'

    const bytes = urlBase64ToUint8Array(key)

    expect(bytes).toHaveLength(65)
    expect(bytes[0]).toBe(4)
  })
})
