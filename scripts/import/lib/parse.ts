// Value parsers for the formats found in the Airtable exports.

import type { Currency } from '../staging.ts';

// Airtable linked-record names come with stray quotes, newlines and bidi marks.
export function cleanName(raw: string): string {
  return raw
    .replace(/[‎‏⁦-⁩]/g, '')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Order-insensitive key: "Sheinberger Yaakov" and "Yaakov Sheinberger" match.
export function nameKey(raw: string): string {
  return cleanName(raw)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

export function splitNames(raw: string): string[] {
  return raw.split(',').map(cleanName).filter(Boolean);
}

// d/m/yyyy → yyyy-mm-dd. Returns undefined for anything else.
export function parseDate(raw: string): string | undefined {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return undefined;
  const [, d, mo, y] = m;
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

// "$56960", "UAH6000", "1,878.60 RON", "430.0" → number.
export function parseAmount(raw: string): number | undefined {
  const cleaned = raw.replace(/[^\d.,-]/g, '').replace(/,/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

const CURRENCY_WORDS: [RegExp, Currency][] = [
  [/גריבנ|uah|₴/i, 'UAH'],
  [/דולר|usd|\$/i, 'USD'],
  [/אירו|euro|eur|€/i, 'EUR'],
  [/לארי|gel|₾/i, 'GEL'],
  [/\bron\b|\blei\b|לאו/i, 'RON'],
  [/ש"?ח|ils|₪/i, 'ILS'],
];

export function parseCurrency(raw: string): Currency | undefined {
  for (const [pattern, code] of CURRENCY_WORDS) if (pattern.test(raw)) return code;
  return undefined;
}

// Edit-distance similarity between two name keys, 0..1.
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

// True when every token of the shorter key appears in the longer one
// ("ayala ravina" ⊂ "ayala malka ravina").
export function tokenSubset(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const longTokens = new Set(long.split(' '));
  const shortTokens = short.split(' ');
  return shortTokens.length >= 1 && shortTokens.every((t) => longTokens.has(t)) && short !== long;
}
