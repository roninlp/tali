# `@tali/tsconfig`

Shared TypeScript configuration for the workspace. Each package extends the
preset that matches its runtime and keeps its own `include` list.

## Presets

- `base.json` — Node/library defaults: ES2023, strict, bundler resolution,
  `noEmit`.
- `worker.json` — Cloudflare Worker defaults: base plus the Workers and
  Vitest-plugin types, with an ES2023-only lib.
- `web.json` — browser app defaults: ES2022, DOM, stricter index and optional
  property checking.

The package has no build step; TypeScript reads the JSON directly through the
workspace link.

## Effect language service

`base.json` and `web.json` enable the Effect LSP plugin
(`@effect/language-service`) for every project that extends them, so editors
get Effect diagnostics, hover, completions and refactors without per-package
configuration. Two options keep the noise in check:

- `diagnosticSeverity.unstableApiUsage` is `off`: Effect 4 marks much of the
  API this repo builds on as unstable, and
  `apps/web-foldkit/.oxlintrc.effect.json` opts out of the same rule.
- `ignoreEffectWarningsInTscExitCode` is `true`: Effect warnings appear in
  `pnpm typecheck` output but only Effect errors fail the build.

The plugin is inert until the installed TypeScript is patched by
`effect-tsgo patch`, which the root `prepare` script does on every install.
