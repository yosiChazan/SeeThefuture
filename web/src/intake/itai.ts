// Itai's per-client file for Romania ("<Owner> - properties table.xlsx", Dropbox).
//
// Sheets: "Incomes" (the leases on top, then every amount received in lei),
// "Expenses" (what Itai's office paid: management commission, broker fees,
// repairs), "Received from owner" (the owner paying those back) and "Totals".
// Rent is paid by the tenant straight into the owner's bank account; Itai's office
// pays expenses and the owner reimburses them every quarter (SPEC decision 44).
//
// The whole history is imported, from the start of the management contract, so the
// balance with Itai needs no opening balance and must equal his own bottom line:
//   expenses + VAT − repayments = "Total remaining to receive" on the Totals sheet
// (SPEC decision 48). Itai's invoices add VAT (19%, 21% from 1.8.2025) to the expenses
// he passes on; each repayment is posted in full and its VAT part as a separate cost
// (SPEC decision 47).

import { round2, expectHeader, num, text } from './util.ts';
import { FormatError, type Book, type Grid, type ParseResult, type ParsedLease, type ParsedRow, type PropertyHint, type ProposedEntry } from './types.ts';

const ADAPTER = 'itai';

// Romanian standard VAT on Itai's invoices: 19%, 21% from 1.8.2025. The rate follows the
// period invoiced, written in the details ("apr. - jun.2025 management fee", paid in
// October at 19%); without one, the day the owner paid.
const MON: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
export function itaiVat(paid: string | null, details = ''): number {
  const when = lastMonthIn(details) ?? paid;
  return when && when < '2025-08-01' ? 0.19 : 0.21;
}

// The last month named in a text ("apr. - jun.2025 management fee" → 2025-06-01).
export function lastMonthIn(s: string): string | null {
  const last = [...s.toLowerCase().matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(20\d\d)/g)].at(-1);
  return last ? `${last[2]}-${MON[last[1]]}-01` : null;
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

// The leases on top of "Incomes". Headers are Romanian in some files ("Data preluare",
// "Chirie", "Closed") and English in others ("Entry date", "Rent", "End date"). The
// personal ID columns (CNP / PIN, ID) are never read.
export function parseItaiLeases(incomes: Grid, receiptsStart: number, owner: string): ParsedLease[] {
  const find = (re: RegExp, what: string) => {
    for (let c = 1; c <= incomes.cols; c++) if (re.test(text(incomes, 1, c))) return c;
    throw new FormatError(`הקובץ לא בפורמט המוכר: בטבלת החוזים בגיליון Incomes חסרה העמודה "${what}"`);
  };
  if (!/^client$/i.test(text(incomes, 1, 1))) return [];
  const col = {
    contract: find(/^ctr\.?$/i, 'Ctr.'), signed: find(/^(data ctr\.?|ctr\.? date)$/i, 'Data ctr. / Ctr. date'),
    start: find(/^(data preluare|entry date)$/i, 'Data preluare / Entry date'), deposit: find(/^(garantie|deposit)/i, 'Garantie / Deposit'),
    rent: find(/^(chirie|rent)/i, 'Chirie / Rent'), end: find(/^(closed|end date)$/i, 'Closed / End date'), apt: find(/^ap\.?$/i, 'AP.'),
  };
  const notesCol = col.apt + 1;
  const out: ParsedLease[] = [];
  for (let r = 2; r < receiptsStart; r++) {
    const tenant = text(incomes, r, 1);
    const aptRef = text(incomes, r, col.apt);
    // Blank tenant: the second lot of a lease on the row above ("Covaci10_L2"). "vacant ...": no lease.
    if (!tenant || !aptRef || /^vacant/i.test(tenant) || /^incomes$/i.test(tenant)) continue;
    const errors: string[] = [];
    const hint = itaiHint(aptRef, owner) ?? { ref: aptRef, unit: '' };
    const start = isoDate(incomes.value(r, col.start)) ?? isoDate(incomes.value(r, col.signed));
    const end = isoDate(incomes.value(r, col.end));
    const rent = num(incomes.value(r, col.rent));
    const deposit = num(incomes.value(r, col.deposit));
    if (!start) errors.push('חסר תאריך התחלה בחוזה');
    if (rent === null) errors.push(`שכירות לא מספרית: "${text(incomes, r, col.rent) || 'ריק'}"`);
    if (deposit === null && text(incomes, r, col.deposit)) errors.push(`פיקדון לא ידוע: "${text(incomes, r, col.deposit)}"`);
    const no = text(incomes, r, col.contract);
    const signed = isoDate(incomes.value(r, col.signed));
    out.push({
      ref: `Incomes!R${r}`, property: hint, tenant, start, end, rent, deposit, currency: 'EUR',
      contract: [no && !/^(fn|-)$/i.test(no) ? `חוזה ${no}` : 'חוזה', signed ? `מ-${signed.split('-').reverse().join('.')}` : ''].filter(Boolean).join(' '),
      notes: text(incomes, r, notesCol), errors,
    });
  }
  return out;
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
  const checks: string[] = [];
  let owner = '';
  let latest = '';
  // The balance with Itai, piece by piece, for the equation against Totals.
  const sums = { expenses: 0, vat: 0, repaid: 0 };

  const push = (row: Omit<ParsedRow, 'fingerprint'> & { counterparty: string }) => {
    const p = row.proposed!;
    if (p.occurred_on > latest) latest = p.occurred_on;
    const amount = p.entries[0].amount;
    const { counterparty, ...rest } = row;
    // Two months are often paid on the same day for the same amount; the month and
    // the description tell them apart.
    rows.push({ ...rest, fingerprint: [ADAPTER, row.property.ref, p.category, p.occurred_on, p.period, amount, counterparty, p.description].join('|') });
  };
  const month = (d: string) => `${d.slice(0, 8)}01`;

  // Incomes: the receipts table starts at the row whose first cell is "amount received (RON)".
  const start = findRow(incomes, /^amount received \(RON\)$/i);
  if (!start) throw new FormatError('הקובץ לא בפורמט המוכר: בגיליון Incomes לא נמצאה הכותרת "amount received (RON)"');
  const ic = headerCols(incomes, start);
  const col = {
    amount: 1, date: need(ic, 'date', 'Incomes'), what: need(ic, 'explanation', 'Incomes'), period: need(ic, 'period', 'Incomes'),
    client: need(ic, 'client', 'Incomes'), owner: need(ic, 'beneficiary', 'Incomes'), apt: need(ic, 'apartment', 'Incomes'),
  };
  let lastSeen = '';
  for (let r = start + 1; r <= incomes.rows; r++) {
    const amount = num(incomes.value(r, col.amount));
    if (amount === null || !amount) continue;
    const what = text(incomes, r, col.what).toLowerCase();
    const forMonth = isoDate(incomes.value(r, col.period));
    const date = isoDate(incomes.value(r, col.date));
    owner ||= text(incomes, r, col.owner);
    const aptRef = text(incomes, r, col.apt);
    const tenant = text(incomes, r, col.client);
    const issues: string[] = [];
    const errors: string[] = [];
    // Older rows often have only the month the rent was for; that is good enough.
    if (!date && forMonth) issues.push('אין תאריך קבלה בקובץ; נרשם לפי חודש השכירות');
    if (!date && !forMonth) errors.push('חסר תאריך: נרשם לפי השורה הקודמת');
    const on = date ?? forMonth ?? (lastSeen || '2024-01-01');
    lastSeen = on;
    const category = what === 'rent' ? 'rent' : what === 'deposit' ? 'deposit' : what === 'utilities' ? 'utilities' : 'other';
    if (category === 'other') errors.push(`סוג תקבול לא מוכר: "${what || 'ריק'}"`);
    const hint = itaiHint(aptRef, text(incomes, r, col.owner)) ?? { ref: aptRef || '(ללא דירה)', unit: '' };
    const label = { rent: 'שכירות', deposit: 'פיקדון', utilities: 'החזר חשבונות', other: 'תקבול' }[category]!;
    push({
      ref: `Incomes!R${r}`, property: hint, kind: label,
      proposed: {
        occurred_on: on, period: month(forMonth ?? on), category, description: `${category === 'other' ? what || label : label} מ-${tenant}`,
        entries: [{ amount: round2(amount), currency: 'RON', account: { kind: 'client_bank', holder: 'beneficiary' } }],
      },
      issues, errors, counterparty: tenant,
      raw: { sheet: 'Incomes', row: r, property_ref: hint.ref, tenant, explanation: what, period: forMonth },
    });
  }

  // Costs of the owner rather than of one apartment ("all", "none") and the owner's
  // repayments are booked on his first apartment, so every lei stays in the balance.
  const anchor = rows.find((x) => x.property.unit || x.property.street)?.property;

  // Expenses paid by Itai's office for the owner.
  expectHeader(expenses, 1, 1, /^amount paid \(RON\)$/i, 'amount paid (RON)');
  const ec = headerCols(expenses, 1);
  const e = {
    date: need(ec, 'date', 'Expenses'), to: need(ec, 'beneficiary', 'Expenses'), what: need(ec, 'explanation', 'Expenses'),
    by: need(ec, 'paid by', 'Expenses'), apt: need(ec, 'apartment', 'Expenses'),
  };
  lastSeen = '';
  for (let r = 2; r <= expenses.rows; r++) {
    const amount = num(expenses.value(r, 1));
    if (amount === null || !amount) continue;
    const date = isoDate(expenses.value(r, e.date));
    const what = text(expenses, r, e.what);
    sums.expenses += amount;
    const aptRef = text(expenses, r, e.apt);
    const issues = [`שולם ל-${text(expenses, r, e.to)} על ידי ${text(expenses, r, e.by)}`];
    const errors: string[] = [];
    // "jul.2024 management commision" without a date: booked in that month.
    const named = lastMonthIn(what);
    if (!date && named) issues.push('אין תאריך תשלום בקובץ; נרשם לפי החודש שבתיאור');
    if (!date && !named) errors.push('חסר תאריך תשלום: נרשם לפי השורה הקודמת');
    const on = date ?? named ?? (lastSeen || '2024-01-01');
    lastSeen = on;
    const hint = itaiHint(aptRef, owner);
    if (!hint && anchor) issues.push(`הוצאה כללית של הבעלים ("${aptRef || 'ריק'}"); נרשמה על הדירה הראשונה שלו`);
    if (!hint && !anchor) errors.push(`ההוצאה רשומה ל"${aptRef || 'ריק'}" ולא לדירה, ולא נמצאה דירה של הבעלים בקובץ`);
    const category = expenseCategory(what);
    const entries: ProposedEntry[] = [{ amount: -round2(amount), currency: 'RON', memo: what, account: { kind: 'manager_cash', holder: 'source' } }];
    push({
      ref: `Expenses!R${r}`, property: hint ?? anchor ?? { ref: aptRef || '(ללא דירה)', unit: '' },
      kind: category === 'mgmt_fee' ? 'דמי ניהול' : 'הוצאה',
      proposed: { occurred_on: on, period: month(on), category, description: what, entries },
      issues, errors, counterparty: text(expenses, r, e.to),
      raw: { sheet: 'Expenses', row: r, property_ref: (hint ?? anchor)?.ref ?? aptRef, paid_to: text(expenses, r, e.to), paid_by: text(expenses, r, e.by) },
    });
  }

  // The owner paying Itai back: from the owner's bank account to Itai's balance for him.
  expectHeader(received, 1, 1, /^amount received$/i, 'Amount received');
  for (let r = 2; r <= received.rows; r++) {
    const amount = num(received.value(r, 1));
    if (amount === null || !amount) continue;
    const date = isoDate(received.value(r, 2));
    const details = text(received, r, 4);
    const invoice = text(received, r, 3);
    const vat = itaiVat(date, details);
    const vatPart = round2(amount - amount / (1 + vat));
    sums.repaid += amount; sums.vat += vatPart;
    const errors = date ? [] : ['חסר תאריך: לבדוק מתי הבעלים שילם. לא לסמן "לא לרשום": בלי השורה נוסחת האיזון מול איתי לא תתאים'];
    if (!anchor) errors.push('לא נמצאה דירה בקובץ לרישום ההחזר');
    const on = date ?? latest;
    const property = anchor ?? { ref: '(ללא דירה)', unit: '' };
    const raw = { sheet: 'Received from owner', row: r, property_ref: anchor?.ref ?? '', invoice, details };
    push({
      ref: `Received!R${r}`, property, kind: 'החזר מהבעלים לאיתי',
      proposed: {
        occurred_on: on, period: month(on), category: 'transfer',
        description: `החזר לאיתי${invoice ? ` (חשבונית ${invoice})` : ''}${details ? `: ${details}` : ''}`,
        entries: [
          { amount: round2(amount), currency: 'RON', account: { kind: 'manager_cash', holder: 'source' } },
          { amount: -round2(amount), currency: 'RON', account: { kind: 'client_bank', holder: 'beneficiary' } },
        ],
      },
      issues: [], errors, counterparty: `invoice ${invoice}`, raw,
    });
    push({
      ref: `Received!R${r}`, property, kind: `מע"מ ${Math.round(vat * 100)}%`,
      proposed: {
        occurred_on: on, period: month(on), category: 'vat',
        description: `מע"מ ${Math.round(vat * 100)}% על החשבונית של איתי${invoice ? ` ${invoice}` : ''}`,
        entries: [
          { amount: -vatPart, currency: 'RON', account: { kind: 'manager_cash', holder: 'source' } },
          { amount: vatPart, currency: 'RON', external: 'source' },
        ],
      },
      issues: [`ההחזר ${round2(amount)} lei כולל מע"מ; ${round2(amount - vatPart)} lei מכסים הוצאות`], errors, counterparty: `vat ${invoice}`, raw,
    });
  }
  if (!owner) throw new FormatError('לא נמצא שם הבעלים (עמודת beneficiary) בגיליון Incomes');

  // The balance equation: what the owner still owes Itai, ours against his.
  const totals = book.sheet(/^totals$/i);
  const leftRow = totals ? findRow(totals, /remaining to receive/i) : 0;
  const left = leftRow ? num(totals!.value(leftRow, 2)) : null;
  const ours = round2(sums.expenses + sums.vat - sums.repaid);
  const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const equation = `הוצאות ${fmt(sums.expenses)} + מע"מ ${fmt(sums.vat)} − החזרים ${fmt(sums.repaid)} = ${fmt(ours)} lei`;
  if (left === null) warnings.push(`לא נמצאה בגיליון Totals השורה "Total remaining to receive", ולכן אין בדיקת איזון. לפי השורות: ${equation}`);
  else if (Math.abs(left - ours) > 1) warnings.push(`נוסחת האיזון לא מתאימה: ${equation}, אבל לפי Totals של איתי נשאר ${fmt(round2(left))} lei`);
  else checks.push(`נוסחת האיזון מול איתי מתאימה: ${equation}, ולפי Totals ${fmt(round2(left))} lei`);

  if (!rows.length) warnings.push('לא נמצאו שורות בקובץ');
  return { period: month(latest || '2026-01-01'), rows, warnings, checks, scope: owner, leases: parseItaiLeases(incomes, start, owner) };
}
