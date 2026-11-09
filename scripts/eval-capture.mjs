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

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")

const parseEnvFile = (path) => {
  if (!existsSync(path)) return {}
  const values = {}
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

const fromFile = parseEnvFile(resolve(root, ".env"))
for (const name of ["OPENCODE_API_KEY", "CAPTURE_BASE_URL", "CAPTURE_MODEL"]) {
  if (process.env[name] === undefined && fromFile[name] !== undefined) {
    process.env[name] = fromFile[name]
  }
}

if (
  process.env.OPENCODE_API_KEY === undefined ||
  process.env.OPENCODE_API_KEY.trim() === ""
) {
  console.error(
    "eval:capture needs OPENCODE_API_KEY (in the environment or .env). " +
      "pnpm test stays offline and does not need it."
  )
  process.exit(2)
}

const result = spawnSync(
  "pnpm",
  [
    "--filter",
    "@tali/api",
    "exec",
    "vitest",
    "run",
    "test/eval-capture.test.ts",
    "--reporter=verbose",
  ],
  { stdio: "inherit", cwd: root, env: process.env }
)

process.exit(result.status ?? 1)
