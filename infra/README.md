# infra — Alchemy v2

Declares the Tali Cloudflare stack (D1 database + api Worker binding) as typed
TypeScript. See `docs/research/alchemy-v2-cloudflare.md`.

- `stack.ts` — the Stack (D1 + Worker binding).
- Migrations live in `packages/sql/migrations/` (referenced from `stack.ts`).

Run `alchemy plan --stage dev` / `alchemy deploy --stage dev` from here once
Cloudflare credentials are configured (`~/.alchemy/profiles.json`).
