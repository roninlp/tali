import { defineConfig, devices } from "@playwright/test"

/**
 * The five gate flows from #81, run against a real local stack (#84).
 *
 * `scripts/stack.mjs` boots `alchemy dev --stage e2e`: a fresh local D1 (a new
 * stage has no rows and the migrations run on reconcile), the api Worker in
 * workerd on :8787 and the Vite SPA on :3000 — the same two origins the app is
 * developed against, because the API's CORS allow-list and the session cookie
 * are both origin-sensitive.
 *
 * One worker, no retries. The flows share one household and one D1, and a
 * retried flow would hide the ordering/flake the ticket asks us to prove
 * absent. Tests isolate by minting unique titles and ids, so a second run on
 * the same database (or a `--repeat-each`) is still meaningful.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env.CI !== undefined,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI === undefined
    ? [["list"], ["html", { open: "never" }]]
    : [["github"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3000",
    // A failing flow must leave enough to debug it: the trace carries the DOM
    // and network, the video the timing, and the screenshot the final frame.
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    // Persian UI, Tehran wall clock: the flow titles compute "today" and the
    // Jalali week from this zone, so the browser must agree with the API seed.
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    reducedMotion: "reduce"
  },
  projects: [
    { name: "seed", testMatch: /seed\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["seed"]
    }
  ],
  webServer: {
    command: "node scripts/stack.mjs",
    url: "http://localhost:3000",
    // Never attach to a developer stack: the flows need the fresh `e2e` stage,
    // and silently reusing `dev_<user>` would run them against real local data.
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    // Ask the wrapper to tear its process group down; see scripts/stack.mjs.
    gracefulShutdown: { signal: "SIGTERM", timeout: 8_000 }
  }
})
