# Vendored anti-slop Oxlint plugins

Source bundle: `/home/ronin/.agents/skills/install-anti-slop/assets/anti-slop`, installed on 2026-11-09.

Source repository and commit: **unknown**. The skill bundle carries no repository URL, commit, version, or recoverable pristine snapshot. The installation therefore records the bundle path and date rather than claiming an upstream revision. The vendored `padding-line-between-statements` adapter has its own provenance in `vendor/eslint-stylistic/UPSTREAM.md` (ESLint Stylistic commit `435c3ea0fd26a5fef9042c4b36b6e165fbbf8d08`).

## Installed plugin paths

- Generic plugin: `packages/lint-config/anti-slop/index.ts` (plugin name `anti-slop`)
- Effect plugin: `packages/lint-config/anti-slop/effect/index.ts` (plugin name `anti-slop-effect`)
- Vendored Stylistic rule: `packages/lint-config/anti-slop/vendor/eslint-stylistic/`, including its `LICENSE` and provenance.

## Local adaptations

None to the bundled rule source. Shared configuration lives in `packages/lint-config`:

- `oxlint/base.json` is the workspace baseline: corrected Oxlint defaults,
  `no-unused-vars`, and `typescript/no-explicit-any`.
- `oxlint/strict.json` registers the generic anti-slop plugin and all generic
  rules, including the native `oxc/no-accumulating-spread` companion rule.
- `oxlint/effect.json` registers the opt-in Effect plugin and its five rules.
- The root `vite.config.ts` `lint` block extends the generated `.oxlintrc.ts`,
  which extends the generated `base.ts`. `vp lint` and `vp check` apply it to
  every package. The JSON files remain for nested configs.
- `apps/web-foldkit/.oxlintrc.json` extends the root `.oxlintrc.json` plus
  `strict`, `effect`, and the Foldkit recommended config. This is the only
  strict consumer today; Vite+ preserves it until it is merged manually.
- `@oxlint/plugins` is pinned to `1.85.0` in this package, matching the
  `oxlint` catalog version. `@foldkit/oxlint-plugin` independently brings
  `@oxlint/plugins@1.90.0`; the two versions coexist.

## Adoption policy

The base preset applies everywhere. The strict and Effect presets are opt-in so
a package can be cleaned before it adopts them. Add them to that package's
nested `.oxlintrc.json`, not to the root config.

## Verification

- `pnpm lint` loads the plugins through the root and nested configs and reports
  rule diagnostics.
- `pnpm quality` runs the root lint and format checks.
- Application cleanup is tracked separately. Enabling a strict preset surfaces
  existing findings rather than suppressing them.
