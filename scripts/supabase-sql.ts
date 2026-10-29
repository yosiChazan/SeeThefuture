// Runs SQL against the Supabase project through the Management API.
//
//   node scripts/supabase-sql.ts migrate          apply supabase/migrations not yet applied
//   node scripts/supabase-sql.ts run <file.sql>   run one SQL file (e.g. the import script)
//
// Needs SUPABASE_ACCESS_TOKEN (personal access token). SUPABASE_PROJECT_REF
// defaults to the production project. Behind an HTTP proxy, run with
// NODE_USE_ENV_PROXY=1 so fetch uses it.
//
// Applied migrations are recorded in supabase_migrations.schema_migrations,
// the same table the Supabase CLI uses, so either tool can take over.

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const REF = process.env.SUPABASE_PROJECT_REF ?? 'oqvanprfxsdonzldgtnq';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const MIGRATIONS = join(import.meta.dirname, '..', 'supabase', 'migrations');

async function query(sql: string): Promise<unknown[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 2000)}`);
  return body ? JSON.parse(body) : [];
}

async function migrate() {
  await query(`
    create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (
      version text primary key, statements text[], name text);`);
  const applied = new Set(
    ((await query('select version from supabase_migrations.schema_migrations')) as { version: string }[])
      .map((r) => r.version));
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const [version, ...rest] = basename(file, '.sql').split('_');
    if (applied.has(version)) { console.log(`skip  ${file}`); continue; }
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    // One request per migration: the API runs it as a single transaction.
    await query(`${sql}\n;insert into supabase_migrations.schema_migrations (version, name) values ('${version}', '${rest.join('_')}');`);
    console.log(`apply ${file}`);
  }
}

async function main() {
  const [cmd, file] = process.argv.slice(2);
  if (!TOKEN) throw new Error('SUPABASE_ACCESS_TOKEN is not set');
  if (cmd === 'migrate') return migrate();
  if (cmd === 'run' && file) {
    const rows = await query(readFileSync(file, 'utf8'));
    console.log(`ok ${file}${Array.isArray(rows) && rows.length ? `: ${JSON.stringify(rows).slice(0, 500)}` : ''}`);
    return;
  }
  console.error('usage: node scripts/supabase-sql.ts migrate | run <file.sql>');
  process.exit(1);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
