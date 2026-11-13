import { describe, expect, it } from 'vite-plus/test'

import { API_URL } from './config'

describe('API_URL', () => {
  it('uses the page origin in dev so Vite proxies the api routes', () => {
    expect(API_URL).toBe(globalThis.location.origin)
  })
})
