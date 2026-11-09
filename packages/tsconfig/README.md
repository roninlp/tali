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
