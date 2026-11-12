/*
 * Env-file plumbing for the local scripts (`test:push`, `eval:capture`).
 *
 * These scripts run before the workspace's TypeScript build, so the parser is
 * a dependency-free subset of a dotenv file: `KEY=value` lines, an optional
 * `export ` prefix, `#` comments and one layer of matching quotes. It is not a
 * variable-expansion engine, and nothing here needs it to be.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** The repository root, resolved from this file rather than the caller's cwd. */
export const repoRoot = resolve(import.meta.dirname, '../..')

export const parseEnvFile = path => {
  if (!existsSync(path)) return {}
  const values = {}
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    )
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

/** Merge env files in order: a later file wins, a missing one contributes nothing. */
export const loadEnvFiles = paths =>
  paths.reduce((merged, path) => ({ ...merged, ...parseEnvFile(path) }), {})
