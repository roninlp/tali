/*
 * The local stack's fixed addresses, stage and state directories.
 *
 * The Playwright gate flows, the two Foldkit smoke scripts and `stack.mjs` all
 * talk to the same two origins: the api Worker on :8787 and the Foldkit SPA on
 * :3001, which is the only pair the app's CORS allow-list and host-scoped
 * session cookie accept. Pinning them once keeps a changed port from being
 * changed in four places.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const WEB_PORT = 3001
export const API_PORT = 8787

export const WEB_URL = `http://localhost:${WEB_PORT}`
export const API_URL = `http://localhost:${API_PORT}`

/** `stack.mjs` boots this stage, so a gate run never touches `dev_<user>`. */
export const STAGE = process.env.E2E_STAGE ?? 'e2e'

const packageRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(packageRoot, '..', '..')

/**
 * Alchemy's local state for the e2e stage. `stack.mjs` deletes it before every
 * run, which is what gives the flows an empty D1 with the migrations applied.
 */
export const ALCHEMY_STATE_DIR = join(
  repoRoot,
  'infra',
  '.alchemy',
  'state',
  'tali',
  STAGE,
)

/** The seed project's output (identities, household, run tag). */
export const SEED_STATE_DIR = join(packageRoot, '.state')
