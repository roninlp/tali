# @tali/lint-config

Shared Oxlint JS plugins and the typed Effect lint preset for the workspace.

## Where the config lives

- **Main lint config:** the root `vite.config.ts` `lint` block. It owns the base
  rules, ignore patterns, the `vite-plus` plugin, and the `apps/web-foldkit`
  override that applies the strict anti-slop, Effect, and Foldkit rule sets.
  There is no `.oxlintrc.json` in the workspace.
- **Typed Effect pass:** `oxlint/effect-typed.ts`. Oxlint's `typeAware` option is
  root-level, so this pass cannot live in the shared `lint` block: only
  `apps/web-foldkit/src` needs the type-aware `effecttsgo` plugin that
  `effect-tsgo patch --oxlint` installs. `pnpm lint:effect` runs it.

## Plugins

- `anti-slop/index.ts` registers the generic anti-slop rules.
- `anti-slop/effect/index.ts` registers the Effect service/tagged-value rules.

The root config loads both by relative path for `apps/web-foldkit` files. The
vendored rule source and its provenance live in `anti-slop/`.

`@oxlint/plugins` is pinned to the Oxlint version bundled by Vite+ (1.93.0), so
the plugin authoring API matches the linter.

## Adoption

1. The base rules apply to every package. New base findings are fixed before
   merge.
2. Strict, Effect, and Foldkit rules currently apply to `apps/web-foldkit/src`.
   To adopt them in another package, add a `lint.overrides` entry in the root
   `vite.config.ts` with that package's files and the same rule blocks.
3. Run `pnpm lint` or `pnpm quality`; CI runs the same commands.
