import { FormatError, type Grid } from './types.ts';

export const text = (g: Grid, r: number, c: number): string => {
  const v = g.value(r, c);
  return v === null ? '' : String(v).trim();
};

// Numbers come as numbers, or as text in either "47 024,34" or "1,348.68" style.
export function num(v: string | number | null): number | null {
  if (v === null || v === '') return null;
  if (typeof v === 'number') return v;
  let s = v.replace(/[\s $₴]/g, '');
  if (/,\d{1,2}$/.test(s) && !/\.\d/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
  // Ukrainian sheet names in Vitaly's report
  'січень': 1, 'лютий': 2, 'березень': 3, 'квітень': 4, 'травень': 5, 'червень': 6,
  'липень': 7, 'серпень': 8, 'вересень': 9, 'жовтень': 10, 'листопад': 11, 'грудень': 12,
};

// "СІЧЕНЬ 2026", "Utilities for January 2026", "2026_RENT_JANUARY_PLC.xlsx"
export function findPeriod(...texts: string[]): string | null {
  for (const t of texts) {
    const s = t.toLowerCase();
    const year = s.match(/20\d\d/)?.[0];
    const month = Object.entries(MONTHS).find(([name]) => new RegExp(`(^|[^\\p{L}])${name}([^\\p{L}]|$)`, 'u').test(s))?.[1];
    if (year && month) return `${year}-${String(month).padStart(2, '0')}-01`;
  }
  return null;
}

export function lastDay(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return `${period.slice(0, 8)}${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

// "27.01." in a January 2026 report → 2026-01-27; "25.12." in January → previous year.
export function dayMonth(s: string, period: string): string | null {
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?$/);
  if (!m) return null;
  const [py, pm] = period.split('-').map(Number);
  const month = Number(m[2]);
  let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : py;
  if (!m[3] && month > pm + 1) year -= 1;
  return `${year}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// Fails loudly when a manager changes the layout (SPEC §5).
export function expectHeader(g: Grid, r: number, c: number, pattern: RegExp, what: string) {
  if (!pattern.test(text(g, r, c))) {
    throw new FormatError(`הקובץ לא בפורמט המוכר: בתא ${String.fromCharCode(64 + c)}${r} ציפיתי ל"${what}" ומצאתי "${text(g, r, c) || 'ריק'}"`);
  }
}

export function findCol(g: Grid, r: number, pattern: RegExp, what: string): number {
  for (let c = 1; c <= g.cols; c++) if (pattern.test(text(g, r, c))) return c;
  throw new FormatError(`הקובץ לא בפורמט המוכר: לא נמצאה עמודה "${what}" בשורה ${r}`);
}
