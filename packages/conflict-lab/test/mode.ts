/**
 * How long the lab runs, resolved from the CLI flag **in Node** and injected
 * into workerd at transform time.
 *
 * `process.env` is not forwarded into the Workers runtime, so the test module
 * cannot read the flag itself (that bug made the "nightly" run identical to
 * the PR run). `vitest.config.ts` calls `resolveLabMode` and passes the result
 * through Vite's `define` and a miniflare binding; `harness.ts` exposes the
 * define as `LAB_MODE`, and `harness.test.ts` checks it agrees with the
 * binding.
 */
export interface LabMode {
  readonly nightly: boolean
  readonly numRuns: number
  readonly maxSteps: number
}

export const resolveLabMode = (raw: string | undefined): LabMode => {
  const nightly = raw === "1"
  return {
    nightly,
    numRuns: nightly ? 100 : 20,
    maxSteps: nightly ? 70 : 40
  }
}
