## Vendored Repositories

This project vendors external repositories under @repos/

- Use vendored repositories as read-only reference material when working with related libraries
- Prefer examples and patterns from the vendored source code over generated guesses or web search results
- Do not edit files under @repos/ unless explicitly asked
- Do not import from @repos/ - application code should continue importing from normal package dependencies

When writing Effect code, inspect @repos/effect/ for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect patterns.

When writing Foldkit code, inspect @repos/foldkit/ for framework source, runnable examples, the docs site, and production apps. It is pinned to the installed release.

## Frontend: Foldkit migration

The frontend is migrating from Solid to [Foldkit](https://foldkit.dev) (Elm Architecture on Effect).

- **New app:** `apps/web-foldkit` (`@tali/web-foldkit`). Read `apps/web-foldkit/FOLDKIT.md` and `apps/web-foldkit/AGENTS.md` before editing it.
- **Legacy app:** `apps/web` (`@tali/web`) is the Solid v2 implementation. Keep it working and use it as the behavioral reference until the migration is complete. Do not edit it during migration work unless the task explicitly says so.
- **AI setup:** Foldkit skills are linked in `.agents/skills/`; DevTools MCP is configured in `opencode.json` and `apps/web-foldkit/.mcp.json`. Start the app with `pnpm --filter @tali/web-foldkit dev` (port 3001), open it in a browser, then use the `foldkit_*` MCP tools to inspect the Model and Message history.
- **Versions:** the Foldkit app pins Effect 4.1 while the rest of the workspace is on Effect 4.0.x. Keep that split until the migration lands; do not upgrade the workspace as a side effect.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each mapped to a same-named label. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: a root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.