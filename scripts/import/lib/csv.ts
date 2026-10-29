// Reads an Airtable CSV export into plain records with trimmed header names.
// Columns that hold credentials are dropped here, before anything else sees them.

import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';

export type Row = Record<string, string>;

// Card numbers, CVV, PIN/PUK, SIM numbers, usernames and passwords for
// clients' bank, mail and utility accounts (docs/SPEC.md §7, §12).
const CREDENTIAL_COLUMN = new RegExp(
  [
    'password', 'סיסמ', '\\bpin\\b', '\\bpuk\\b', 'cvv', '3 digit', '3 ספרות',
    'כרטיס', 'card', 'מספר סים', '\\bsim\\b', 'סים', 'שם משתמש', 'קוד סודי',
    'user and password', 'מייל מקושר', 'אימייל שפתחנו', 'שקיבל סמס',
  ].join('|'),
  'i',
);

export function isCredentialColumn(header: string): boolean {
  return CREDENTIAL_COLUMN.test(header);
}

export function readCsv(path: string): Row[] {
  const records: Record<string, string>[] = parse(readFileSync(path), {
    columns: (headers: string[]) => headers.map((h) => h.trim()),
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
  });
  return records.map((record) => {
    const row: Row = {};
    for (const [key, value] of Object.entries(record)) {
      if (key && !isCredentialColumn(key)) row[key] = (value ?? '').trim();
    }
    return row;
  });
}
