# Abroad properties

Management layer for client-owned apartments in Ukraine, Romania, Georgia and Greece.
The company is not a property manager: local managers run the apartments and send
reports; this system collects those reports, keeps a ledger per client, and shows it
to the office, management and clients.

**Read `docs/SPEC.md` first.** It is the source of truth: domain, decisions (§10) and
open questions (§11). Record every new decision there.

## Stack

- Supabase: Postgres + RLS, Auth, Storage, Edge Functions (TypeScript/Deno)
- Frontend: React + Vite + TypeScript + Mantine, Hebrew RTL, in `web/`
- All tables live in the `app` schema. Expose it in the Supabase API settings.

## Layout

- `supabase/migrations/` – schema, one file per change, never edit an applied migration
- `supabase/tests/` – policy tests; `supabase_stub.sql` imitates Supabase locally
- `scripts/test-db.sh` – applies all migrations to a throwaway Postgres and runs the tests
- `docs/` – spec and diagrams
- `web/` – office app (static SPA; talks to Supabase with the publishable key, RLS decides what each user sees)

## Rules that the schema enforces

- Money is never converted silently. An FX conversion is one transaction with two
  entries in two currencies.
- Only `finance` (or admin) can post a transaction. Posted transactions are immutable;
  correct them by voiding and re-entering.
- Time-bound relations (ownership, management, leases, expected rent) are closed with
  `valid_to`, never deleted.
- Card numbers, CVV, PIN and bank passwords are never stored. They belong in Bitwarden.
- Staff see nothing until they complete TOTP (`aal2`); clients are exempt. Every new table
  in `app` gets the restrictive `require_mfa` policy (see migration 6).

## Commands

```bash
npm test                                              # importer unit tests + database policy tests
node scripts/import/report.ts <airtable-dir> <out>    # dry-run import: staging.json + cleanup report
```

`<airtable-dir>` holds `ukraine/`, `romania/`, `georgia/` with the Airtable CSV exports.
Exports contain client personal data: keep them and the report outside the repo.
Manual data decisions go in `scripts/import/corrections.ts`.

### Office app

```bash
cd web && npm install
cp .env.example .env   # project URL + publishable key; on Cloudflare Pages set the same two variables
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build into web/dist
npm test           # report adapters against anonymized fixtures of real reports
```

Report adapters live in `web/src/intake/` (one file per manager's format, pure functions over
a `Grid`). Their fixtures in `web/src/intake/fixtures/` are real reports with every person's
name replaced; keep it that way. A layout change in a report must make an adapter throw
`FormatError`, never import wrong numbers.

`web/.env.example` holds the project URL and the publishable key (safe in the browser). Never
put a secret key there. A user sees the app only after an admin gives them a row in
`app.profiles` (and `app.user_country_roles` for staff); signing up alone gives nothing.

### Loading into Supabase

Needs `SUPABASE_ACCESS_TOKEN` in the environment (a personal access token; never paste it
in chat). `NODE_USE_ENV_PROXY=1` makes Node's fetch use the sandbox proxy.

```bash
NODE_USE_ENV_PROXY=1 node scripts/supabase-sql.ts migrate          # apply new migrations
node scripts/import/report.ts <airtable-dir> <out>                  # review <out>/import-report.html
node scripts/import/load.ts <out>/staging.json <out>/load.sql       # idempotent SQL
NODE_USE_ENV_PROXY=1 node scripts/supabase-sql.ts run <out>/load.sql
scripts/test-db.sh <out>/load.sql                                   # same load on a local Postgres first
```

After the first migration, add `app` to Exposed schemas in the Supabase API settings.
