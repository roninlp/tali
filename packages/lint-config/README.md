# @tali/lint-config

Shared Oxlint configuration for the workspace. The root `.oxlintrc.json`
extends the base preset, and Oxlint's nested-config resolution applies it to
every package. Packages add a local `.oxlintrc.json` only when they need
overrides; `apps/web-foldkit` is the current example.

## Presets

- `@tali/lint-config/oxlint/base` — required baseline: Oxlint's default
  correctness rules, `no-unused-vars` with the workspace's ignore patterns, and
  `typescript/no-explicit-any`.
- `@tali/lint-config/oxlint/strict` — opt-in generic anti-slop rules, including
  the native `oxc/no-accumulating-spread` companion. Extend base first.
- `@tali/lint-config/oxlint/effect` — opt-in anti-slop rules for Effect
  tagged values and service construction. Extend base and strict first.

The root config uses the linked dependency path because `.oxlintrc.json` does
not support package specifiers:

```json
{
  "extends": ["./node_modules/@tali/lint-config/oxlint/base.json"]
}
```

A package config uses a relative path to the root config, then adds its local
presets:

```json
{
  "extends": [
    "../../.oxlintrc.json",
    "./node_modules/@tali/lint-config/oxlint/strict.json"
  ]
}
```

`apps/web-foldkit` also extends the Foldkit recommended config and keeps its
local `sort-imports` and `typescript/consistent-type-assertions` rules.

## Root tasks

Oxlint and Oxfmt run once from the repository root, following the Turborepo
Oxc guide. The root `package.json` owns `lint`, `lint:fix`, `format`, and
`format:fix`; `turbo.json` registers `//#lint`, `//#format`, `//#quality`, and
their fix variants. Packages do not repeat those scripts.

The formatter has one root `.oxfmtrc.jsonc`; package-specific format options
use its `overrides` array. `apps/web-foldkit` uses that for import sorting.

## Adoption

1. Keep the base preset green. New base findings are fixed before merge.
2. Add `strict` to a package's local config only when its existing findings are
   resolved or explicitly tracked.
3. Add `effect` when the package owns Effect tagged values or services.
4. Run `pnpm exec turbo run quality`; CI runs the same task.

The vendored anti-slop source and its provenance live in `anti-slop/`.
