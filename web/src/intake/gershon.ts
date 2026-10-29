// Gershon's monthly building expenses for PLC (Utilities_PLC_<Month>_<Year>.xlsx).
//
// One block of four rows per apartment: "3(29)" (building 3, apartment 29), the
// owners, building management + security and water with their bank commissions,
// legal services, and in column K the client's dollar balance as free text:
// "126,22 - 88,17 =$38,05" (dollars converted to pay this month) or
// "Need to pay 3692,78" (no dollars left; the client owes the amount in hryvnia).
//
// The expenses are paid from the client's dollar expense fund at Gershon: one FX
// transaction (dollars out, hryvnia in, at the implied rate) and one transaction
// per expense in hryvnia (SPEC §4.3). Without dollars the hryvnia fund goes negative.

import { round2, expectHeader, findPeriod, lastDay, num, text } from './util.ts';
import { FormatError, type Grid, type ParseResult, type ParsedRow, type PropertyHint } from './types.ts';

const ADAPTER = 'gershon';

export function gershonHint(ref: string, owners: string): PropertyHint | null {
  const m = ref.match(/^(\d+)\s*\((\d+)\)$/);
  if (!m) return null;
  // Owners are written "Latin / Cyrillic"; keep the Latin names.
  const latin = owners.split(/\/|\n/).map((s) => s.trim()).filter((s) => s && !/[Ѐ-ӿ]/.test(s));
  return { ref, building: m[1], unit: m[2], project: 'Lake city', owner: latin.join(', ') || undefined };
}

export function parseGershonBalance(s: string): { before: number; usd: number; after: number } | { owes: number } | null {
  const m = s.match(/([\d\s.,]+)\s*-\s*([\d\s.,]+)\s*=\s*\$?\s*([\d\s.,]+)/);
  if (m) {
    const [before, usd, after] = [num(m[1]), num(m[2]), num(m[3])];
    if (before !== null && usd !== null && after !== null) return { before, usd, after };
  }
  const owe = s.match(/need to pay\s*([\d\s.,]+)/i);
  if (owe && num(owe[1]) !== null) return { owes: num(owe[1])! };
  return null;
}

export function parseGershon(g: Grid, fileName = ''): ParseResult {
  expectHeader(g, 1, 2, /Build\.?\s*Apt/i, 'Build. Apt.');
  expectHeader(g, 1, 3, /Owner/i, "Owner's name");
  expectHeader(g, 1, 4, /Utilities for/i, 'Utilities for <Month> <Year>');
  expectHeader(g, 1, 5, /Total amount according to receipts/i, 'Total amount according to receipts, UAH');
  expectHeader(g, 1, 6, /Bank commission/i, 'Bank commission upon payment, UAH');
  expectHeader(g, 1, 9, /Legal services/i, 'Legal services, UAH');
  expectHeader(g, 1, 11, /Balance/i, 'Balance');

  const period = findPeriod(text(g, 1, 4), fileName);
  if (!period) throw new FormatError('לא הצלחתי לזהות את החודש מכותרת העמודה "Utilities for" או משם הקובץ');
  const on = lastDay(period);

  const rows: ParsedRow[] = [];
  const warnings: string[] = [];
  let sumUtilities = 0; let sumLegal = 0;

  for (let r = 2; r <= g.rows; r++) {
    const hint = gershonHint(text(g, r, 2), text(g, r, 3));
    if (!hint) continue;
    // Building management + security on the first row, water two rows below.
    const lines = [r, r + 2].filter((x) => /▪/.test(text(g, x, 4)));
    const utilities = round2(lines.reduce((s, x) => s + (num(g.value(x, 5)) ?? 0) + (num(g.value(x, 6)) ?? 0), 0));
    const legal = num(g.value(r, 9)) ?? 0;
    const total = round2(utilities + legal);
    sumUtilities += utilities; sumLegal += legal;
    const fileTotal = num(g.value(r, 10));
    const balanceText = text(g, r + 1, 11) || text(g, r, 11);
    const balance = parseGershonBalance(balanceText);
    const issues: string[] = [];
    if (fileTotal !== null && Math.abs(fileTotal - total) > 0.01) issues.push(`סה"כ בקובץ ${fileTotal}, מחושב מהשורות ${total}`);
    const raw = { row: r, property_ref: hint.ref, owner: hint.owner, utilities, legal, total, balance_text: balanceText };
    const add = (kind: string, p: ParsedRow['proposed'], amount: number, extra: string[] = []) => rows.push({
      ref: `R${r}`, property: hint, kind, proposed: p, issues: [...issues, ...extra], raw,
      fingerprint: p ? [ADAPTER, hint.ref, period, p.category, amount].join('|') : null,
    });

    if (!balance) {
      issues.push(`לא זוהתה יתרה דולרית בעמודה K ("${balanceText || 'ריק'}")`);
    } else if ('usd' in balance) {
      if (Math.abs(round2(balance.before - balance.usd) - balance.after) > 0.01) issues.push(`חישוב היתרה בקובץ לא מסתדר: ${balanceText}`);
      const rate = Math.round((total / balance.usd) * 10000) / 10000;
      add('המרת דולר לגריבנה', {
        occurred_on: on, period, category: 'fx', description: `המרה לתשלום הוצאות ${hint.ref}: $${balance.usd} → ${total} ₴`,
        entries: [
          { amount: -balance.usd, currency: 'USD', fx_rate: rate, account: { kind: 'expense_pool', holder: 'source' } },
          { amount: total, currency: 'UAH', fx_rate: rate, account: { kind: 'expense_pool', holder: 'source' } },
        ],
      }, balance.usd, [`יתרה דולרית לפי גרשון: $${balance.before} → $${balance.after}`]);
    } else if (Math.abs(balance.owes - total) > 0.01) {
      issues.push(`גרשון כותב "צריך לשלם ${balance.owes}", אבל סך ההוצאות ${total}`);
    }
    const owes = balance && 'owes' in balance ? [`אין יתרה דולרית: הלקוח צריך לשלם ${balance.owes} ₴`] : [];

    if (utilities) add('הוצאות בניין', {
      occurred_on: on, period, category: 'building_fees', description: `ניהול בניין, שמירה ומים ${hint.ref}`,
      entries: [{ amount: -utilities, currency: 'UAH', account: { kind: 'expense_pool', holder: 'source' } }],
    }, utilities, owes);
    if (legal) add('שכ"ט עו"ד', {
      occurred_on: on, period, category: 'legal_fees', description: `שירותים משפטיים ${hint.ref}`,
      entries: [
        { amount: -legal, currency: 'UAH', account: { kind: 'expense_pool', holder: 'source' } },
        { amount: legal, currency: 'UAH', external: 'source' },
      ],
    }, legal, owes);
  }
  if (!rows.length) throw new FormatError('לא נמצאו דירות בדוח');

  // Totals row: "Total amount" in A, utilities in G, legal in I.
  for (let r = 2; r <= g.rows; r++) {
    if (!/^Total amount/i.test(text(g, r, 1))) continue;
    const u = num(g.value(r, 7)); const l = num(g.value(r, 9));
    if (u !== null && Math.abs(u - sumUtilities) > 0.5) warnings.push(`סה"כ הוצאות בניין: בקובץ ${u}, נקרא מהשורות ${round2(sumUtilities)}`);
    if (l !== null && Math.abs(l - sumLegal) > 0.5) warnings.push(`סה"כ שכ"ט: בקובץ ${l}, נקרא מהשורות ${round2(sumLegal)}`);
  }
  return { period, rows, warnings };
}
