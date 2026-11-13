import foldkitRecommended from '@foldkit/oxlint-plugin/recommended.json' with { type: 'json' }
import { defineConfig } from 'vite-plus'

const foldkitRules = foldkitRecommended.rules as Record<string, string>
const foldkitOverrides = foldkitRecommended.overrides as Array<{
  files: string[]
  excludeFiles?: string[]
  rules: Record<string, string>
}>

/** Generic anti-slop rules, previously `packages/lint-config/oxlint/strict.json`. */
const antiSlopRules = {
  'oxc/no-accumulating-spread': 'error',
  'anti-slop/no-array-filter-map': 'error',
  'anti-slop/no-reduce-accumulator-copy': 'error',
  'anti-slop/no-chained-type-assertions': 'error',
  'anti-slop/no-conditional-empty-object-spread': 'error',
  'anti-slop/no-known-value-widening': 'error',
  'anti-slop/no-module-mocking': 'error',
  'anti-slop/no-object-parameters': 'error',
  'anti-slop/no-reflect-apply': 'error',
  'anti-slop/no-reflect-get': 'error',
  'anti-slop/no-runtime-typeof': 'error',
  'anti-slop/no-shape-in-symbol-names': 'error',
  'anti-slop/no-unknown-parameters': 'error',
  'anti-slop/no-unknown-returns': 'error',
  'anti-slop/no-unknown-type-aliases': 'error',
  'anti-slop/no-unsafe-dictionary-type': 'error',
  'anti-slop/no-widen-then-assert': 'error',
  'anti-slop/require-readable-spacing': 'error',
  'anti-slop/require-safety-comment-for-type-assertion': 'error',
}

/** Effect service/tagged-value rules, previously `packages/lint-config/oxlint/effect.json`. */
const antiSlopEffectRules = {
  'anti-slop-effect/no-manual-effect-error-tag': 'error',
  'anti-slop-effect/no-manual-tag-comparison': 'error',
  'anti-slop-effect/no-manual-tagged-construction': 'error',
  'anti-slop-effect/no-service-constructor-imports': 'error',
  'anti-slop-effect/prefer-effect-match': 'error',
}

export default defineConfig({
  run: {
    // Package scripts are uncached by default. `pnpm typecheck`, `pnpm build`,
    // and `pnpm test` opt in per invocation with `--cache`; `dev` and the
    // Alchemy stack scripts need the full environment and stay uncached.
    cache: { scripts: false },
  },
  test: {
    // `vp test` at the workspace root fans out into the package suites.
    // Running `vp test` inside a package still uses that package's Vite
    // config directly.
    projects: [
      'apps/api',
      'apps/web-foldkit',
      'packages/conflict-lab',
      'packages/domain',
      'packages/sync-client',
      'packages/telemetry',
    ],
  },
  // Shared formatter defaults for the workspace.
  // https://oxc.rs/docs/guide/usage/formatter/config-file-reference.html
  fmt: {
    semi: false,
    singleQuote: true,
    arrowParens: 'avoid',
    trailingComma: 'all',
    printWidth: 80,
    sortPackageJson: false,
    ignorePatterns: [
      'node_modules',
      'dist',
      'coverage',
      'playwright-report',
      'test-results',
      '.state',
      '.wrangler',
      'repos',
      '.agents',
      '.github',
      'docs',
      'README.md',
      'AGENTS.md',
      'GLOSSARY.md',
      'packages/lint-config/anti-slop',
      '*.tsbuildinfo',
      'pnpm-lock.yaml',
    ],
    overrides: [
      {
        files: ['apps/web-foldkit/**'],
        options: {
          sortImports: {
            ignoreCase: false,
            customGroups: [
              { groupName: 'scoped', elementNamePattern: ['@*', '@*/**'] },
            ],
            groups: [
              ['builtin', 'external'],
              'scoped',
              ['parent', 'sibling', 'index'],
              'unknown',
            ],
          },
        },
      },
    ],
  },
  lint: {
    plugins: ['typescript', 'oxc'],
    options: {
      // The workspace typechecks with effect-tsgo (`pnpm typecheck`). Oxlint's
      // type-aware rules surface findings that predate this migration (mostly
      // `no-misused-spread` on Effect Schema class instances), so keep the
      // existing non-type-aware gate. The typed Effect pass below opts in for
      // `apps/web-foldkit/src` only.
      typeAware: false,
      typeCheck: false,
    },
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: {
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      'typescript/no-explicit-any': 'error',
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
    ignorePatterns: [
      'node_modules',
      'dist',
      '.agents',
      'repos',
      'patches',
      'packages/lint-config/anti-slop',
      'packages/e2e/playwright-report',
      'packages/e2e/test-results',
      'packages/e2e/.state',
      '**/*.d.ts',
      'pnpm-lock.yaml',
    ],
    overrides: [
      {
        // The old app config ignored `public/` and config files; keep those on
        // the base rules.
        files: ['apps/web-foldkit/src/**', 'apps/web-foldkit/worker.ts'],
        jsPlugins: [
          {
            name: 'anti-slop',
            specifier: './packages/lint-config/anti-slop/index.ts',
          },
          {
            name: 'anti-slop-effect',
            specifier: './packages/lint-config/anti-slop/effect/index.ts',
          },
          { name: 'foldkit', specifier: '@foldkit/oxlint-plugin' },
        ],
        rules: {
          ...antiSlopRules,
          ...antiSlopEffectRules,
          ...foldkitRules,
        },
      },
      // Foldkit's file-specific exceptions (tests, entry, server) stay with
      // the plugin's recommended config instead of being copied here.
      ...foldkitOverrides,
    ],
  },
})
