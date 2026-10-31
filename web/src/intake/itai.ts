// Itai's per-client file for Romania ("<Owner> - properties table.xlsx", Dropbox).
//
// Sheets: "Incomes" (the leases on top, then every amount received in lei),
// "Expenses" (what Itai's office paid: management commission, broker fees,
// repairs), "Received from owner" (the owner paying those back) and "Totals".
// Rent is paid by the tenant straight into the owner's bank account; Itai's office
// pays expenses and the owner reimburses them every quarter (SPEC decision 44).
//
// The file holds the whole history. Only rows from 1.1.2026 are proposed (SPEC
// decision 29); what the owner owed Itai on that day becomes one opening balance,
// worked out from the earlier rows.
//
// Itai's invoices add VAT (19%, 21% from 1.8.2025) to the expenses he passes on, so a
// repayment covers expenses net of VAT. Each repayment is posted in full and its VAT
// part as a separate cost (SPEC decision 47). The "Totals" sheet checks the result.

import { round2, expectHeader, num, text } from './util.ts';
import { FormatError, type Book, type Grid, type ParseResult, type ParsedRow, type PropertyHint, type ProposedEntry } from './types.ts';

const ADAPTER = 'itai';
export const ITAI_FROM = '2026-01-01';

// Romanian standard VAT on Itai's invoices: 19%, 21% from 1.8.2025. The rate follows the
// period invoiced, written in the details ("apr. - jun.2025 management fee", paid in
// October at 19%); without one, the day the owner paid.
const MON: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
export function itaiVat(paid: string | null, details = ''): number {
  const months = [...details.toLowerCase().matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(20\d\d)/g)];
  const last = months.at(-1);
  const when = last ? `${last[2]}-${MON[last[1]]}-01` : paid;
  return when && when < '2025-08-01' ? 0.19 : 0.21;
}

// "Vasile_Lascar6_ap.6-L1" → street "Vasile Lascar 6", apartment 6, lot 1;
// "Covaci10_L1" → street "Covaci 10", lot 1; "Vulcanescu_10" → street "Vulcanescu", apartment 10.
export function itaiHint(ref: string, owner?: string): PropertyHint | null {
  const s = ref.trim();
  if (!s || /^(all|none)$/i.test(s)) return null;
  // "Covaci10_L1+L2": two lots rented together.
  const m = s.match(/^(.*?)(?:_ap\.?\s*(\w+))?(?:[-_]L(\d+(?:\+L?\d+)*))?$/i);
  if (!m) return null;
  let street = m[1];
  let unit = m[2] ?? '';
  // "Vulcanescu_10": the number after the underscore is the apartment.
  const tail = street.match(/^(.*\D)_(\d+)$/);
  if (!unit && tail) { street = tail[1]; unit = tail[2]; }
  street = street.replace(/_/g, ' ').replace(/([a-z])(\d)/gi, '$1 $2').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  return { ref: s, unit, street, lot: m[3]?.replace(/L/gi, ''), owner };
}

const isoDate = (v: string | number | null): string | null => {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
};

function expenseCategory(s: string): string {
  if (/management (fee|commi)/i.test(s)) return 'mgmt_fee';
  if (/broker/i.test(s)) return 'brokerage';
  if (/repair|boiler|\bac\b|sewage|key|door|disinfect|fix|replace/i.test(s)) return 'repair';
  if (/electric|gas\b|heating|water|internet|utilit/i.test(s)) return 'utilities';
  if (/translation|poa|notar|lawyer|legal/i.test(s)) return 'legal_fees';
  return 'other';
}

function findRow(g: Grid, pattern: RegExp, col = 1): number {
  for (let r = 1; r <= g.rows; r++) if (pattern.test(text(g, r, col))) return r;
  return 0;
}

const headerCols = (g: Grid, r: number) => {
  const cols: Record<string, number> = {};
  for (let c = 1; c <= g.cols; c++) { const h = text(g, r, c).toLowerCase(); if (h) cols[h] = c; }
  return cols;
};

function need(cols: Record<string, number>, name: string, sheet: string): number {
  const c = cols[name];
  if (!c) throw new FormatError(`הקובץ לא בפורמט המוכר: בגיליון "${sheet}" חסרה העמודה "${name}"`);
  return c;
}

export function parseItai(book: Book): ParseResult {
  const incomes = book.sheet(/^incomes$/i);
  const expenses = book.sheet(/^expenses$/i);
  const received = book.sheet(/^received from owner$/i);
  if (!incomes || !expenses || !received) {
    throw new FormatError('הקובץ לא בפורמט המוכר: צריכים להיות בו הגיליונות Incomes, Expenses ו-Received from owner');
  }

  const rows: ParsedRow[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  let owner = '';
  let latest = ITAI_FROM;

  // What the owner owed Itai before 2026, and over the whole file (for the Totals check).
  const owed = { expensesBefore: 0, paidNetBefore: 0, expenses: 0, paidNet: 0 };

  const push = (row: Omit<ParsedRow, 'fingerprint'> & { counterparty: string; fingerprint?: string }) => {
    const p = row.proposed!;
    if (p.occurred_on > latest) latest = p.occurred_on;
    const amount = p.entries[0].amount;
    const { counterparty, fingerprint, ...rest } = row;
    if (fingerprint) { rows.push({ ...rest, fingerprint }); return; }
    // Two months are often paid on the same day for the same amount; the month and
    // the description tell them apart.
    rows.push({ ...rest, fingerprint: [ADAPTER, row.property.ref, p.category, p.occurred_on, p.period, amount, counterparty, p.description].join('|') });
  };

  // Incomes: the receipts table starts at the row whose first cell is "amount received (RON)".
  const start = findRow(incomes, /^amount received \(RON\)$/i);
  if (!start) throw new FormatError('הקובץ לא בפורמט המוכר: בגיליון Incomes לא נמצאה הכותרת "amount received (RON)"');
  const ic = headerCols(incomes, start);
  const col = {
    amount: 1, date: need(ic, 'date', 'Incomes'), what: need(ic, 'explanation', 'Incomes'), period: need(ic, 'period', 'Incomes'),
    client: need(ic, 'client', 'Incomes'), owner: need(ic, 'beneficiary', 'Incomes'), apt: need(ic, 'apartment', 'Incomes'),
  };
  for (let r = start + 1; r <= incomes.rows; r++) {
    const amount = num(incomes.value(r, col.amount));
    if (amount === null || !amount) continue;
    const what = text(incomes, r, col.what).toLowerCase();
    const forMonth = isoDate(incomes.value(r, col.period));
    const date = isoDate(incomes.value(r, col.date));
    const on = date ?? forMonth;
    if (on && on < ITAI_FROM) { skipped++; continue; }
    owner ||= text(incomes, r, col.owner);
    const aptRef = text(incomes, r, col.apt);
    const tenant = text(incomes, r, col.client);
    const errors: string[] = [];
    if (!date) errors.push(forMonth ? 'חסר תאריך קבלה; נרשם לפי חודש השכירות' : 'חסר תאריך');
    const category = what === 'rent' ? 'rent' : what === 'deposit' ? 'deposit' : what === 'utilities' ? 'utilities' : 'other';
    if (category === 'other') errors.push(`סוג תקבול לא מוכר: "${what || 'ריק'}"`);
    const hint = itaiHint(aptRef, text(incomes, r, col.owner)) ?? { ref: aptRef || '(ללא דירה)', unit: '' };
    const label = { rent: 'שכירות', deposit: 'פיקדון', utilities: 'החזר חשבונות', other: 'תקבול' }[category]!;
    const period = (forMonth ?? on ?? ITAI_FROM).slice(0, 8) + '01';
    push({
      ref: `Incomes!R${r}`, property: hint, kind: label,
      proposed: {
        occurred_on: on ?? ITAI_FROM, period, category, description: `${category === 'other' ? what || label : label} מ-${tenant}`,
        entries: [{ amount: round2(amount), currency: 'RON', account: { kind: 'client_bank', holder: 'beneficiary' } }],
      },
      issues: [], errors, counterparty: tenant,
      raw: { sheet: 'Incomes', row: r, property_ref: hint.ref, tenant, explanation: what, period: forMonth },
    });
  }

  // Expenses paid by Itai's office for the owner.
  expectHeader(expenses, 1, 1, /^amount paid \(RON\)$/i, 'amount paid (RON)');
  const ec = headerCols(expenses, 1);
  const e = {
    date: need(ec, 'date', 'Expenses'), to: need(ec, 'beneficiary', 'Expenses'), what: need(ec, 'explanation', 'Expenses'),
    by: need(ec, 'paid by', 'Expenses'), apt: need(ec, 'apartment', 'Expenses'),
  };
  for (let r = 2; r <= expenses.rows; r++) {
    const amount = num(expenses.value(r, 1));
    if (amount === null || !amount) continue;
    const date = isoDate(expenses.value(r, e.date));
    const what = text(expenses, r, e.what);
    owed.expenses += amount;
    // Undated rows belong to 2026 only when they say so ("jan.2026 management commision").
    if ((date && date < ITAI_FROM) || (!date && !/20(2[6-9]|[3-9]\d)/.test(what))) { owed.expensesBefore += amount; skipped++; continue; }
    const aptRef = text(expenses, r, e.apt);
    const errors: string[] = [];
    if (!date) errors.push('חסר תאריך תשלום');
    const hint = itaiHint(aptRef, owner);
    if (!hint) errors.push(`ההוצאה רשומה ל"${aptRef || 'ריק'}" ולא לדירה אחת. לבחור דירה, או לא לרשום`);
    const category = expenseCategory(what);
    const entries: ProposedEntry[] = [{ amount: -round2(amount), currency: 'RON', memo: what, account: { kind: 'manager_cash', holder: 'source' } }];
    push({
      ref: `Expenses!R${r}`, property: hint ?? { ref: aptRef || '(ללא דירה)', unit: '' },
      kind: category === 'mgmt_fee' ? 'דמי ניהול' : 'הוצאה',
      proposed: { occurred_on: date ?? latest, period: (date ?? latest).slice(0, 8) + '01', category, description: what, entries },
      issues: [`שולם ל-${text(expenses, r, e.to)} על ידי ${text(expenses, r, e.by)}`], errors, counterparty: text(expenses, r, e.to),
      raw: { sheet: 'Expenses', row: r, property_ref: hint?.ref ?? aptRef, paid_to: text(expenses, r, e.to), paid_by: text(expenses, r, e.by) },
    });
  }

  // The owner paying Itai back: from the owner's bank account to Itai's balance for him.
  // Not tied to one apartment; booked on the owner's first apartment in the file.
  expectHeader(received, 1, 1, /^amount received$/i, 'Amount received');
  const anchor = rows.find((x) => x.property.unit || x.property.street)?.property;
  for (let r = 2; r <= received.rows; r++) {
    const amount = num(received.value(r, 1));
    if (amount === null || !amount) continue;
    const date = isoDate(received.value(r, 2));
    const vat = itaiVat(date, text(received, r, 4));
    const net = amount / (1 + vat);
    owed.paidNet += net;
    if (date && date < ITAI_FROM) { owed.paidNetBefore += net; skipped++; continue; }
    const vatPart = round2(amount - net);
    const details = text(received, r, 4);
    const invoice = text(received, r, 3);
    const errors = date ? [] : ['חסר תאריך: לבדוק מתי הבעלים שילם'];
    if (!anchor) errors.push('לא נמצאה דירה בקובץ לרישום ההחזר');
    push({
      ref: `Received!R${r}`, property: anchor ?? { ref: '(ללא דירה)', unit: '' }, kind: 'החזר מהבעלים לאיתי',
      proposed: {
        occurred_on: date ?? latest, period: (date ?? latest).slice(0, 8) + '01', category: 'transfer',
        description: `החזר לאיתי${invoice ? ` (חשבונית ${invoice})` : ''}${details ? `: ${details}` : ''}`,
        entries: [
          { amount: round2(amount), currency: 'RON', account: { kind: 'manager_cash', holder: 'source' } },
          { amount: -round2(amount), currency: 'RON', account: { kind: 'client_bank', holder: 'beneficiary' } },
        ],
      },
      issues: [], errors, counterparty: `invoice ${invoice}`,
      raw: { sheet: 'Received from owner', row: r, property_ref: anchor?.ref ?? '', invoice, details },
    });
    push({
      ref: `Received!R${r}`, property: anchor ?? { ref: '(ללא דירה)', unit: '' }, kind: `מע"מ ${Math.round(vat * 100)}%`,
      proposed: {
        occurred_on: date ?? latest, period: (date ?? latest).slice(0, 8) + '01', category: 'vat',
        description: `מע"מ ${Math.round(vat * 100)}% על החשבונית של איתי${invoice ? ` ${invoice}` : ''}`,
        entries: [
          { amount: -vatPart, currency: 'RON', account: { kind: 'manager_cash', holder: 'source' } },
          { amount: vatPart, currency: 'RON', external: 'source' },
        ],
      },
      issues: [`ההחזר ${round2(amount)} lei כולל מע"מ; ${round2(net)} lei מכסים הוצאות`], errors, counterparty: `vat ${invoice}`,
      raw: { sheet: 'Received from owner', row: r, property_ref: anchor?.ref ?? '', invoice, details },
    });
  }

  // What the owner owed Itai on 1.1.2026 (negative) or had paid ahead (positive).
  const opening = round2(owed.paidNetBefore - owed.expensesBefore);
  if (Math.abs(opening) >= 0.01) {
    push({
      ref: 'Totals', property: anchor ?? { ref: '(ללא דירה)', unit: '' }, kind: 'יתרת פתיחה',
      proposed: {
        occurred_on: ITAI_FROM, period: ITAI_FROM, category: 'opening_balance',
        description: `יתרת פתיחה מול איתי ב-1.1.2026: ${opening < 0 ? 'הבעלים חייב לאיתי' : 'הבעלים שילם מראש'}`,
        entries: [{ amount: opening, currency: 'RON', account: { kind: 'manager_cash', holder: 'source' } }],
      },
      issues: [`הוצאות עד סוף 2025: ${round2(owed.expensesBefore)} lei; הוחזר עד אז בלי מע"מ: ${round2(owed.paidNetBefore)} lei`],
      errors: [`יתרת פתיחה ${opening} lei, מחושבת מהשורות שלפני 2026. לאשר שזו הפעם הראשונה שהקובץ של הבעלים נקלט`],
      counterparty: '', fingerprint: [ADAPTER, owner, 'opening'].join('|'),
      raw: { sheet: 'Totals', row: 0, property_ref: anchor?.ref ?? '' },
    });
  }

  // Itai's own bottom line: what is left to receive from the owner, before VAT.
  const totals = book.sheet(/^totals$/i);
  const leftRow = totals ? findRow(totals, /remaining to receive/i) : 0;
  const left = leftRow ? num(totals!.value(leftRow, 2)) : null;
  const ours = round2(owed.expenses - owed.paidNet);
  if (left !== null && Math.abs(left - ours) > 1) {
    warnings.push(`לפי גיליון Totals נשאר לגבות מהבעלים ${round2(left)} lei, ולפי השורות ${ours} lei. ההפרש כנראה בשיעור המע"מ של חלק מההחזרים`);
  }

  if (!owner) throw new FormatError('לא נמצא שם הבעלים (עמודת beneficiary) בגיליון Incomes');
  if (skipped) warnings.push(`${skipped} שורות לפני ${ITAI_FROM.split('-').reverse().join('.')} לא נקלטו (היתרות מתחילות מ-0 ב-1.1.2026)`);
  if (!rows.length) warnings.push('אין בקובץ שורות מ-2026');
  return { period: latest.slice(0, 8) + '01', rows, warnings };
}
