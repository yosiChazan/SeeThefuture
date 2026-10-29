import type { Currency } from '../lib/types';

// A worksheet as the adapters see it: 1-based rows and columns, the cached value
// of each cell (the result for formulas) and the formula text where there is one.
export interface Grid {
  sheet: string;
  rows: number;
  cols: number;
  value(r: number, c: number): string | number | null;
  formula(r: number, c: number): string | null;
}

export interface ProposedEntry {
  amount: number;
  currency: Currency;
  memo?: string;
  fx_rate?: number;
  // "source": the manager holding the money; "beneficiary": the owner's own account.
  account?: { kind: 'manager_cash' | 'rent_pool' | 'expense_pool' | 'legacy_card' | 'client_bank' | 'hotel_balance'; holder: 'source' | 'beneficiary' };
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
}

export interface ParsedRow {
  ref: string;           // sheet row in the original file, e.g. "R3"
  property: PropertyHint;
  kind: string;          // short label for the reviewer
  proposed: ProposedTransaction | null;   // null: information only, nothing to post
  fingerprint: string | null;
  issues: string[];
  raw: Record<string, unknown>;
}

export interface ParseResult {
  period: string;        // YYYY-MM-01
  rows: ParsedRow[];
  warnings: string[];    // file-level checks, e.g. totals that do not add up
}

// The file is not in the format the adapter knows. Nothing is imported.
export class FormatError extends Error {}
