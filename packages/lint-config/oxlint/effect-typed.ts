// The typed Effect pass. Oxlint's `typeAware` option is root-level, so this
// config stays separate from the workspace `vite.config.ts` lint block: only
// `apps/web-foldkit/src` needs the type-aware `effecttsgo` plugin that
// `effect-tsgo patch --oxlint` installs. Run it with `pnpm lint:effect`.
import correctness from '@effect/tsgo/oxlint-presets/correctness.json' with { type: 'json' }

export default {
  lint: {
    ...correctness,
    categories: { correctness: 'off' },
    rules: {
      ...correctness.rules,
      'effecttsgo/catch-unfailable-effect': 'warn',
      'effecttsgo/effect-fn-iife': 'warn',
      'effecttsgo/effect-gen-uses-adapter': 'warn',
      'effecttsgo/effect-in-failure': 'warn',
      'effecttsgo/effect-in-void-success': 'warn',
      'effecttsgo/layer-merge-all-with-dependencies': 'warn',
      'effecttsgo/lazy-promise-in-effect-sync': 'warn',
      'effecttsgo/leaking-requirements': 'warn',
      'effecttsgo/multiple-effect-provide': 'warn',
      'effecttsgo/prefer-typed-schema-decoder': 'warn',
      'effecttsgo/prefer-unsafe-constructor': 'warn',
      'effecttsgo/return-effect-in-gen': 'warn',
      'effecttsgo/schema-sync-in-effect': 'warn',
      'effecttsgo/scope-in-layer-effect': 'warn',
      'effecttsgo/try-catch-in-effect-gen': 'warn',
      'effecttsgo/unstable-api-usage': 'off',
      'effecttsgo/unknown-in-effect-catch': 'warn',
    },
  },
}
