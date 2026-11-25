// Vitaly's monthly rent report for Kyiv, PLC (RENT_<MONTH>_PLC.xlsx).
//
// One block per apartment. The first row of a block has the number in column A and
// "PLC 17(2), APT. 12\n<owner>" in B; the rows below carry the lease dates in B and
// one expense per row. Rent arrives in cash or to a card account; Vitaly keeps his fee (10% until
// September 2026, 15% from October: the percentage is read from the column's title)
// of each. Debts are shown for information and posted by nobody (SPEC §4.3).

import { round2, dayMonth, expectHeader, findCol, findPeriod, lastDay, num, prevMonth, text } from './util.ts';
import { FormatError, type Book, type Grid, type ParseResult, type ParsedRow, type PropertyHint, type ProposedEntry } from './types.ts';

const ADAPTER = 'vitaly';

function expenseCategory(s: string): string {
  if (/utilit/i.test(s)) return 'utilities';
  if (/broker/i.test(s)) return 'brokerage';
  if (/repair|finish|mattress|furnit|fix/i.test(s)) return 'repair';
  return 'other';
}

// "PLC 17(2), APT. 12" → building 2, apartment 12 in Lake City.
export function vitalyHint(cell: string): PropertyHint | null {
  // Bilingual cells (until December 2025): "ПЛС 17 (2) КВ.12\n<name>/\n\nPLC 17(2), APT. 12\n<name>". The
  // English part starts at the line with "PLC".
  const lines = cell.split('\n').map((s) => s.trim()).filter(Boolean);
  const at = Math.max(0, lines.findIndex((l) => /^PLC\s*\d/i.test(l)));
  const [first, ...rest] = lines.slice(at);
  const m = first?.match(/PLC\s*(\d+)\s*\((\d+)\)\s*,?\s*APT\.?\s*(\d+)/i);
  if (!m) return null;
  // One spelling for every month ("APT.36" in June, "APT. 36" in January), so the
  // name remembered in external_refs keeps matching.
  return { ref: `PLC ${m[1]}(${m[2]}), APT. ${m[3]}`, building: m[2], unit: m[3], project: 'Lake city', owner: rest.join(' ') || undefined };
}

// Until December 2025 the titles were in Ukrainian and English ("ГОТІВКА/\nCASH"): the English
// part, after the last slash, is what the checks below read (decision 166).
const CYRILLIC = /[\u0400-\u04FF№]/;
export function englishTitle(v: unknown): unknown {
  if (typeof v !== 'string' || !CYRILLIC.test(v)) return v;
  const m = /\/\s*([^\u0400-\u04FF№]*)$/s.exec(v);
  return m ? m[1].trim() : v;
}

export function parseVitaly(book: Book, fileName = ''): ParseResult {
  const raw = book.sheets[0];
  const g: Grid = { ...raw, value: (r, c) => (r === 1 ? englishTitle(raw.value(r, c)) as ReturnType<Grid['value']> : raw.value(r, c)), formula: (r, c) => raw.formula(r, c), hidden: (r) => raw.hidden(r) };
  expectHeader(g, 1, 1, /^No\.?$/i, 'No.');
  expectHeader(g, 1, 2, /REPORT FOR/i, 'REPORT FOR <MONTH>');
  const col = {
    cash: findCol(g, 1, /^CASH$/i, 'CASH'),
    card: findCol(g, 1, /^CARD ACCOUNT/i, 'CARD ACCOUNT'),
    // "EXPENSES FOR JANUARY" in January, "EXPENSES JUNE" in June.
    expenses: findCol(g, 1, /^EXPENSES\b/i, 'EXPENSES <MONTH>'),
    feeCash: findCol(g, 1, /\d+(\.\d+)?\s*% FOR MANAGEMENT FROM CASH/i, '<N>% FOR MANAGEMENT FROM CASH'),
    feeCard: findCol(g, 1, /\d+(\.\d+)?\s*% FOR MANAGEMENT FROM CARD/i, '<N>% FOR MANAGEMENT FROM CARD ACCOUNT'),
    other: findCol(g, 1, /OTHER EXP[AE]NSES/i, 'OTHER EXPENSES'),  // spelled "EXPANSES" in January
    debtFee: findCol(g, 1, /DEBT FOR MANAGEMENT/i, 'DEBT FOR MANAGEMENT'),
    debtOther: findCol(g, 1, /DEBT FOR OTHER/i, 'DEBT FOR OTHER EXPENSES'),
  };
  // Vitaly's fee as the report states it ("15% FOR MANAGEMENT FROM CASH").
  const feePct = Number(/(\d+(?:\.\d+)?)\s*%/.exec(text(g, 1, col.feeCash))?.[1] ?? 10);
  // Each amount column has its date in the column to its left.
  for (const c of [col.cash, col.card, col.expenses, col.feeCash, col.feeCard]) expectHeader(g, 1, c - 1, /^DATE$/i, 'DATE');

  const period = findPeriod(g.sheet, text(g, 1, 2), fileName);
  if (!period) throw new FormatError('לא הצלחתי לזהות את החודש של הדוח משם הגיליון או משם הקובץ');

  // The totals row (=SUM in the cash column) closes the last block.
  let end = g.rows;
  for (let r = 2; r <= g.rows; r++) if (/^=SUM\(/i.test(g.formula(r, col.cash) ?? '')) { end = r - 1; break; }
  const starts: number[] = [];
  for (let r = 2; r <= end; r++) if (text(g, r, 1) && vitalyHint(text(g, r, 2))) starts.push(r);
  if (!starts.length) throw new FormatError('לא נמצאו דירות בדוח');

  const rows: ParsedRow[] = [];
  const warnings: string[] = [];
  const sums = { cash: 0, card: 0, fees: 0, other: 0 };

  starts.forEach((start, i) => {
    const stop = (starts[i + 1] ?? end + 1) - 1;
    const hint = vitalyHint(text(g, start, 2))!;
    const lease: string[] = [];
    for (let r = start + 1; r <= stop; r++) if (text(g, r, 2)) lease.push(text(g, r, 2));
    const date = (r: number, c: number) => dayMonth(text(g, r, c - 1), period) ?? lastDay(period);
    // A date before the previous month is usually a copy of an old row ("22.01." in June).
    const stale = (on: string) => on < prevMonth(period) ? [`התאריך ${on.split('-').reverse().join('.')} רחוק מחודש הדוח. לבדוק מול ויטאלי`] : [];

    const add = (r: number, kind: string, category: string | null, amount: number, on: string, description: string,
      entries: ProposedEntry[], issues: string[] = [], errors: string[] = []) => {
      rows.push({
        ref: `R${r}`, property: hint, kind, issues, errors,
        proposed: category ? { occurred_on: on, period, category, description, entries } : null,
        fingerprint: category ? [ADAPTER, hint.ref, period, category, on, amount].join('|') : null,
        raw: { row: r, property_ref: hint.ref, owner: hint.owner, lease: lease.join(' | '), amount, description },
      });
    };

    for (let r = start; r <= stop; r++) {
      const cash = num(g.value(r, col.cash));
      if (cash) {
        sums.cash += cash;
        add(r, 'שכירות', 'rent', cash, date(r, col.cash), `שכירות ${hint.ref}`,
          [{ amount: cash, currency: 'UAH', account: { kind: 'manager_cash', holder: 'source' } }], [], stale(date(r, col.cash)));
      }
      const card = num(g.value(r, col.card));
      if (card) {
        sums.card += card;
        add(r, 'שכירות לכרטיס', 'rent', card, date(r, col.card), `שכירות לכרטיס ${hint.ref}`,
          [{ amount: card, currency: 'UAH', account: { kind: 'legacy_card', holder: 'beneficiary' } }], [], stale(date(r, col.card)));
      }
      const feeCash = num(g.value(r, col.feeCash));
      if (feeCash) {
        sums.fees += feeCash;
        add(r, `דמי ניהול ${feePct}%`, 'mgmt_fee', feeCash, date(r, col.feeCash), 'דמי ניהול לויטאלי (מזומן)', [ // the description is how a report already imported is recognized again: kept as it was
          { amount: -feeCash, currency: 'UAH', account: { kind: 'manager_cash', holder: 'source' } },
          { amount: feeCash, currency: 'UAH', external: 'source' },
        ], [], cash && Math.abs(feeCash - round2(cash * feePct / 100)) > 1 ? [`דמי הניהול (${feeCash}) אינם ${feePct}% מהשכירות (${cash})`] : []);
      }
      const feeCard = num(g.value(r, col.feeCard));
      if (feeCard) {
        sums.fees += feeCard;
        add(r, `דמי ניהול ${feePct}% (כרטיס)`, 'mgmt_fee', feeCard, date(r, col.feeCard), 'דמי ניהול לויטאלי (כרטיס)', [
          { amount: -feeCard, currency: 'UAH', account: { kind: 'legacy_card', holder: 'beneficiary' } },
          { amount: feeCard, currency: 'UAH', external: 'source' },
        ]);
      }
      const other = num(g.value(r, col.other));
      if (other) {
        sums.other += other;
        const what = text(g, r, col.expenses);
        add(r, 'הוצאה', expenseCategory(what), other, date(r, col.expenses), what || 'הוצאה',
          [{ amount: -other, currency: 'UAH', memo: what, account: { kind: 'manager_cash', holder: 'source' } }]);
      }
      const debtFee = num(g.value(r, col.debtFee));
      if (debtFee) add(r, 'חוב דמי ניהול', null, debtFee, lastDay(period), 'חוב דמי ניהול', [], [`חוב דמי ניהול לויטאלי: ${debtFee} ₴ (לידיעה, לא נרשם)`]);
      const debtOther = num(g.value(r, col.debtOther));
      if (debtOther) add(r, 'חוב הוצאות', null, debtOther, lastDay(period), text(g, r, col.expenses), [], [`חוב הוצאות: ${debtOther} ₴ (לידיעה, לא נרשם)`]);
    }
  });

  // The file's own totals must match what was read row by row.
  const total = (c: number) => num(g.value(end + 1, c));
  const check = (label: string, fileTotal: number | null, read: number) => {
    if (fileTotal !== null && Math.abs(fileTotal - read) > 0.5) warnings.push(`${label}: בקובץ ${fileTotal}, נקרא מהשורות ${round2(read)}`);
  };
  check('סה"כ שכירות', total(col.cash), sums.cash);
  check('סה"כ שכירות לכרטיס', total(col.card), sums.card);
  check('סה"כ הוצאות אחרות', total(col.other), sums.other);
  const fileFees = (total(col.feeCash) ?? 0) + (total(col.feeCard) ?? 0);
  check('סה"כ דמי ניהול', fileFees, sums.fees);

  return { period, rows, warnings, scope: period.slice(0, 7) };
}
