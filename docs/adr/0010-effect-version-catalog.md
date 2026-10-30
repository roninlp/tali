# ADR-0010: One Effect version, pinned through a pnpm catalog

- **Status:** Accepted (2026-10-30)
- **Deciders:** Tali developer (Foldkit migration)
- **Related:** `docs/plans/foldkit-migration.md`, `apps/web-foldkit/README.md`

## Context

The Foldkit app requires Effect 4.1 (`foldkit@0.170.0` declares
`effect: ~4.1.0`), while the rest of the workspace was on Effect 4.0.5. That
split was fine while the two frontends were independent, but it blocks the
migration's first real integration: `@tali/rpc` and `@tali/domain` are built
against one Effect version, and importing them into an app resolving another
version yields two runtimes and incompatible Effect types.

Shared dependency versions were also copied into every `package.json`, so a
bump in one package could silently drift from the others. `@tali/ui` already
depended on the legacy app's Solid version this way.

## Decision

- **A pnpm catalog in `pnpm-workspace.yaml` is the single source of truth** for
  dependency versions shared by more than one workspace package. Manifests
  reference them as `catalog:`.
- **The whole workspace runs one Effect minor.** The catalog pins the Effect
  suite (`effect`, `@effect/platform-browser`, `@effect/platform-node`,
  `@effect/sql-d1`) to `~4.1.0`, matching Foldkit's peer range. A caret would
  let a later install select 4.2.x and break the Foldkit peer contract.
- **Package-specific versions stay in the package.** Foldkit and its
  `@foldkit/*` packages are pinned exact because they release together; only
  the genuinely shared toolchain (TypeScript, Vite, Vitest, Tailwind, oxlint,
  `@types/node`, the Effect suite, and the Solid runtime) belongs in the
  catalog.
- **Bump shared versions in the catalog, never in an individual manifest.**
  `pnpm install` rewrites the lockfile once for every consumer.

## Consequences

- `@tali/domain`, `@tali/rpc`, `@tali/config`, and the api resolve to a single
  `effect@4.1.0`; the Foldkit app can import the shared packages without a
  dedupe shim.
- The legacy Solid app shares the upgraded toolchain (TypeScript 7, Vite 8.3,
  Vitest 5.0.4, oxlint 1.85). It stays green under the CI gates; the major
  TypeScript bump should be committed separately from the Effect swap so it
  remains reviewable and revertable.
- Adding a new shared dependency means editing the catalog first, then
  referencing `catalog:`; adding a package-only dependency stays local.
- The catalog's ranges are floors, not exact pins; the lockfile remains the
  reproducibility boundary. Do not run `pnpm update` on the Effect suite
  without bumping Foldkit and re-running its Story/Scene tests.
