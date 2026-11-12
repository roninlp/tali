#!/usr/bin/env node
/*
 * Run the live Capture eval (ticket #101; ADR-0012 §9).
 *
 * `pnpm test` stays offline: every other Capture suite uses ExtractorReplay.
 * This script is the opt-in live check, gated on OPENCODE_API_KEY, and it is
 * deliberately not part of CI.
 *
 * Usage:
 *   pnpm eval:capture
 *
 * The key, base URL and model are read from the environment or the repo-root
 * `.env`. A missing key exits non-zero with an explanation.
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { parseEnvFile, repoRoot } from './lib/env.mjs'

const fromFile = parseEnvFile(resolve(repoRoot, '.env'))
for (const name of ['OPENCODE_API_KEY', 'CAPTURE_BASE_URL', 'CAPTURE_MODEL']) {
  if (process.env[name] === undefined && fromFile[name] !== undefined) {
    process.env[name] = fromFile[name]
  }
}

if (
  process.env.OPENCODE_API_KEY === undefined ||
  process.env.OPENCODE_API_KEY.trim() === ''
) {
  console.error(
    'eval:capture needs OPENCODE_API_KEY (in the environment or .env). ' +
      'pnpm test stays offline and does not need it.',
  )
  process.exit(2)
}

const result = spawnSync(
  'pnpm',
  [
    '--filter',
    '@tali/api',
    'exec',
    'vitest',
    'run',
    'test/eval-capture.test.ts',
    '--reporter=verbose',
  ],
  { stdio: 'inherit', cwd: repoRoot, env: process.env },
)

process.exit(result.status ?? 1)
