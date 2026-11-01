import type { Currency } from '../lib/types';

// A worksheet as the adapters see it: 1-based rows and columns, the cached value
// of each cell (the result for formulas) and the formula text where there is one.
export interface Grid {
  sheet: string;
  rows: number;
  cols: number;
  value(r: number, c: number): string | number | null;
  formula(r: number, c: number): string | null;
  hidden(r: number): boolean;   // a row hidden in Excel (Itai hides past leases)
}

// A whole workbook; most reports use only the first sheet.
export interface Book {
  sheets: Grid[];
  sheet(name: RegExp): Grid | undefined;
}

export interface ProposedEntry {
  amount: number;
  currency: Currency;
  memo?: string;
  fx_rate?: number;
  // "source": the manager holding the money; "beneficiary": the owner's own account.
  // A party id names a holder other than the source (Yarach's transfers reach Gershon).
  account?: { kind: 'manager_cash' | 'rent_pool' | 'expense_pool' | 'legacy_card' | 'client_bank' | 'hotel_balance' | 'deposit_held'; holder: 'source' | 'beneficiary' | (string & {}) };
  external?: 'source';
}

export interface ProposedTransaction {
  occurred_on: string;   // YYYY-MM-DD
  period: string;        // first day of the month
  category: string;      // app.txn_category
  description: string;
  entries: ProposedEntry[];
}

// What a source calls the apartment, split so it can be matched to a property.
export interface PropertyHint {
  ref: string;           // as written in the file, e.g. "PLC 17(2), APT. 12"
  unit: string;
  building?: string;
  project?: string;
  owner?: string;
  // Romania (Itai): the street part of "Vasile_Lascar6_ap.6-L1" and the lot of a split apartment.
  street?: string;
  lot?: string;
  // Manual forms pick the property itself: no matching needed.
  id?: string;
}

export interface ParsedRow {
  ref: string;           // sheet row in the original file, e.g. "R3"
  property: PropertyHint;
  kind: string;          // short label for the reviewer
  proposed: ProposedTransaction | null;   // null: information only, nothing to post
  fingerprint: string | null;
  issues: string[];
  // Discrepancies a person must look at; the batch cannot be approved until each
  // row with errors is marked as checked (or not posted).
  errors: string[];
  raw: Record<string, unknown>;
}

// A lease as a report states it (Itai's leases table). Applied to app.leases on
// approval: added when new, updated when the terms changed (SPEC decision 51).
export interface ParsedLease {
  ref: string;
  property: PropertyHint;
  tenant: string;
  start: string | null;
  end: string | null;
  rent: number | null;
  deposit: number | null;
  currency: Currency;
  contract: string;      // "חוזה 2 מ-16.01.2025"
  notes: string;         // the manager's note, e.g. an extension and a new rent
  errors: string[];
  hidden: boolean;       // a past lease the manager hid in the file: history, never an update
}

export interface ParseResult {
  period: string;        // YYYY-MM-01; for multi-month files, the latest month
  rows: ParsedRow[];
  warnings: string[];    // file-level checks, e.g. totals that do not add up
  checks?: string[];     // file-level checks that passed, shown to the reviewer
  // What a newer version of the same report replaces: Itai's file is per owner,
  // Vitaly's and Gershon's reports are per month.
  scope?: string;
  leases?: ParsedLease[];
}

// The file is not in the format the adapter knows. Nothing is imported.
export class FormatError extends Error {}
