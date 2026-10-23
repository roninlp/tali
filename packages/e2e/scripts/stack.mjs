#!/usr/bin/env node
// Boot the local stack for the Playwright gate flows (ticket #84).
//
// `alchemy dev --stage e2e` is the same single command a developer runs
// (`pnpm dev`), pinned to a stage of its own so the flows never touch the
// developer's `dev_<user>` database:
//
//   - the stage's local state is deleted first, so every run starts from an
//     empty D1 with the real migrations applied on reconcile;
//   - the api Worker binds :8787 and the SPA :3000, the two origins the
//     product is built around (CORS allow-list + host-scoped session cookie).
//
// Playwright owns this process for the length of the run and kills it at the
// end. The preflight below turns the common local mistake — `pnpm dev` still
// running — into one clear message instead of a hung provider update.
import { rmSync } from "node:fs"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const STAGE = process.env.E2E_STAGE ?? "e2e"
const STATE_DIR = join(repoRoot, "infra", ".alchemy", "state", "tali", STAGE)

const busy = (port) =>
  new Promise((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(true))
    server.once("listening", () => server.close(() => resolve(false)))
    server.listen(port, "::")
  })

for (const port of [3000, 8787]) {
  if (await busy(port)) {
    console.error(
      `[e2e] port ${port} is already in use. Stop the running stack (pnpm dev) ` +
        `before the gate flows: they boot their own fresh ${STAGE} stage.`
    )
    process.exit(1)
  }
}

if (process.env.E2E_KEEP_STATE !== "1") {
  rmSync(STATE_DIR, { recursive: true, force: true })
}

const child = spawn(
  "pnpm",
  ["--filter", "@tali/infra", "exec", "alchemy", "dev", "--stage", STAGE, "--no-input"],
  {
    cwd: repoRoot,
    stdio: "inherit",
    // Own process group: alchemy spawns vite and workerd as children, and they
    // are what would otherwise keep :3000/:8787 bound after the run.
    detached: true,
    env: { ...process.env, ALCHEMY_STAGE: STAGE }
  }
)

let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      // Already gone.
    }
    process.exit(0)
  }, 5_000).unref()
}

process.on("SIGTERM", stop)
process.on("SIGINT", stop)
child.on("exit", (code, signal) => {
  if (!stopping) process.exit(code ?? (signal === null ? 1 : 0))
})
