# Vendored anti-slop Oxlint plugins

Source bundle: `/home/ronin/.agents/skills/install-anti-slop/assets/anti-slop`, installed on 2026-11-09.

Source repository and commit: **unknown**. The skill bundle carries no repository URL, commit, version, or recoverable pristine snapshot. The installation therefore records the bundle path and date rather than claiming an upstream revision. The vendored `padding-line-between-statements` adapter has its own provenance in `vendor/eslint-stylistic/UPSTREAM.md` (ESLint Stylistic commit `435c3ea0fd26a5fef9042c4b36b6e165fbbf8d08`).

## Installed plugin paths

- Generic plugin: `packages/lint-config/anti-slop/index.ts` (plugin name `anti-slop`)
- Effect plugin: `packages/lint-config/anti-slop/effect/index.ts` (plugin name `anti-slop-effect`)
- Vendored Stylistic rule: `packages/lint-config/anti-slop/vendor/eslint-stylistic/`, including its `LICENSE` and provenance.

## Local adaptations

None to the bundled rule source. Configuration lives in the root `vite.config.ts`:

- The `lint` block owns the base rules, ignores, and the `apps/web-foldkit`
  override that registers both plugins and enables every generic and Effect
  anti-slop rule for that package.
- `packages/lint-config/oxlint/effect-typed.ts` is the separate type-aware
  Effect pass (`pnpm lint:effect`); it exists because Oxlint's `typeAware`
  option is root-level and only the app src runs the patched `effecttsgo`
  plugin.
- `@oxlint/plugins` is pinned to `1.93.0` in this package, matching the Oxlint
  version bundled by Vite+.

## Adoption policy

The base preset applies everywhere. The strict and Effect presets are opt-in so
a package can be cleaned before it adopts them. Add them through a
`lint.overrides` entry in the root `vite.config.ts`, not a nested config file.

## Verification

- `pnpm lint` loads the base rules plus the app override and reports rule
  diagnostics.
- `pnpm lint:effect` runs the typed Effect pass after patching Oxlint.
- `pnpm quality` runs the root lint and format checks.
- Application cleanup is tracked separately. Enabling a strict preset surfaces
  existing findings rather than suppressing them.
