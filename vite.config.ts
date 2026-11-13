// vp migrate: merged .oxlintrc.json (731fbbf8b15b1208a44722d94580e879).
import oxlintConfig1 from './.oxlintrc.js'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  run: {
    // Package scripts are uncached by default. `pnpm typecheck`, `pnpm build`,
    // and `pnpm test` opt in per invocation with `--cache`; `dev` and the
    // Alchemy stack scripts need the full environment and stay uncached.
    cache: { scripts: false },
  },
  test: {
    // `vp test` at the workspace root fans out into the package suites.
    // Running `vp test` inside a package still uses that package's
    // package's Vite config directly.
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
    extends: [oxlintConfig1],
    ignorePatterns: oxlintConfig1.ignorePatterns,
    options: {
      // The workspace typechecks with effect-tsgo (`pnpm typecheck`). Oxlint's
      // type-aware rules surface findings that predate this migration (mostly
      // `no-misused-spread` on Effect Schema class instances), so keep the
      // existing non-type-aware gate. Enabling them is a separate cleanup.
      typeAware: false,
      typeCheck: false,
    },
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
  },
})
