# Abroad properties

Management layer for client-owned apartments in Ukraine, Romania, Georgia and Greece.
The company is not a property manager: local managers run the apartments and send
reports; this system collects those reports, keeps a ledger per client, and shows it
to the office, management and clients.

**Read `docs/SPEC.md` first.** It is the source of truth: domain, decisions (§10) and
open questions (§11). Record every new decision there.

## Stack

- Supabase: Postgres + RLS, Auth, Storage, Edge Functions (TypeScript/Deno)
- Frontend: React + Vite + TypeScript, Hebrew RTL (not started yet)
- All tables live in the `app` schema. Expose it in the Supabase API settings.

## Layout

- `supabase/migrations/` – schema, one file per change, never edit an applied migration
- `supabase/tests/` – policy tests; `supabase_stub.sql` imitates Supabase locally
- `scripts/test-db.sh` – applies all migrations to a throwaway Postgres and runs the tests
- `docs/` – spec and diagrams

## Rules that the schema enforces

- Money is never converted silently. An FX conversion is one transaction with two
  entries in two currencies.
- Only `finance` (or admin) can post a transaction. Posted transactions are immutable;
  correct them by voiding and re-entering.
- Time-bound relations (ownership, management, leases, expected rent) are closed with
  `valid_to`, never deleted.
- Card numbers, CVV, PIN and bank passwords are never stored. They belong in Bitwarden.

## Commands

```bash
scripts/test-db.sh
```
