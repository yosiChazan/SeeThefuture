// Itai's per-client file for Romania ("<Owner> - properties table.xlsx", Dropbox).
//
// Sheets: "Incomes" (the leases on top, then every amount received in lei),
// "Expenses" (what Itai's office paid: management commission, broker fees,
// repairs), "Received from owner" (the owner paying those back) and "Totals".
// Rent is paid by the tenant straight into the owner's bank account; Itai's office
// pays expenses and the owner reimburses them every quarter (SPEC decision 44).
//
// Two arrangements, sometimes both in one file (SPEC decision 55), told apart row by
// row by who received the money:
//  * direct lease owner ↔ tenant: rent goes to the owner's bank; Itai's office pays
//    expenses and the owner repays them with VAT ("Received from owner");
//  * lease eden (Itai's company) ↔ tenant: eden collects the rent, deducts expenses
//    and the 8% tax, and pays the rest to the owner ("Paid to owner"). A deposit eden
//    collects is the tenant's money and is kept apart.
// The whole history is imported (SPEC decision 48), so Itai's balance with the owner
// needs no opening balance and must equal his own bottom line on the Totals sheet:
//   "remaining to pay owner" − "remaining to receive from owner" (before VAT).
// Single-apartment files ("<Owner> - <Street>_ap.<n> property table.xlsx") have no
// apartment column: the apartment comes from the file name.

import { itaiHebrew, monthHe } from './itai_he.ts';
import { cellNumber, num, round2, text } from './util.ts';
import { FormatError, type Book, type Grid, type ParseResult, type ParsedLease, type ParsedRow, type PropertyHint } from './types.ts';

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
  if (/income tax withheld/i.test(s)) return 'tax_withheld';
  if (/repairs? fund|asoc|association/i.test(s)) return 'building_fees';
  if (/broker/i.test(s)) return 'brokerage';
  if (/repair|boiler|\bac\b|sewage|key|door|disinfect|fix|replace/i.test(s)) return 'repair';
  if (/electric|gas\b|heating|water|internet|utilit/i.test(s)) return 'utilities';
  if (/translation|poa|notar|lawyer|legal/i.test(s)) return 'legal_fees';
  return 'other';
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

// "Demo Owner - Bratianu6_ap.33 property table (1).xlsx" → owner "Demo Owner",
// apartment "Bratianu6_ap.33"; "Second Owner - properties table.xlsx" → no apartment.
export function itaiFileName(fileName: string): { owner: string; apartment: string | null } {
  const base = fileName.replace(/\.xlsx$/i, '').replace(/\s*\(\d+\)\s*$/, '').trim();
  const [owner, ...rest] = base.split(' - ');
  const tail = rest.join(' - ').replace(/\s*propert(y|ies) table\s*$/i, '').trim();
  return { owner: owner.trim(), apartment: tail || null };
}

// The first row, within the first lines, whose first cell matches.
function headerRow(g: Grid, pattern: RegExp, within = 40): number {
  for (let r = 1; r <= Math.min(g.rows, within); r++) if (pattern.test(text(g, r, 1))) return r;
  return 0;
}

// The leases on top of "Incomes". Headers are Romanian in some files ("Data preluare",
// "Chirie", "Closed") and English in others ("Entry date", "Rent (EUR)", "End date" or
// "Closing date"); a title row may come first. The personal ID columns (CNP / PIN, ID)
// are never read.
export function parseItaiLeases(incomes: Grid, receiptsStart: number, owner: string, fileApartment: string | null): ParsedLease[] {
  const h = headerRow(incomes, /^client$/i, 6);
  if (!h) return [];
  const find = (re: RegExp, what: string) => {
    for (let c = 1; c <= incomes.cols; c++) if (re.test(text(incomes, h, c))) return c;
    throw new FormatError(`הקובץ לא בפורמט המוכר: בטבלת החוזים בגיליון Incomes חסרה העמודה "${what}"`);
  };
  const col = {
    contract: find(/^ctr\.?$/i, 'Ctr.'), signed: find(/^(data ctr\.?|ctr\.? date)$/i, 'Data ctr. / Ctr. date'),
    start: find(/^(data preluare|entry date)$/i, 'Data preluare / Entry date'), deposit: find(/^(garantie|deposit)/i, 'Garantie / Deposit'),
    rent: find(/^(chirie|rent)/i, 'Chirie / Rent'), end: find(/^(closed|end date|closing date)$/i, 'Closed / End date / Closing date'),
  };
  let apt = 0;
  for (let c = 1; c <= incomes.cols; c++) if (/^ap\.?$/i.test(text(incomes, h, c))) apt = c;
  if (!apt && !fileApartment) throw new FormatError('הקובץ לא בפורמט המוכר: אין עמודת "AP." בטבלת החוזים, ושם הקובץ לא מציין דירה');
  const notesCol = (apt || col.end) + 1;
  const out: ParsedLease[] = [];
  for (let r = h + 1; r < receiptsStart; r++) {
    const tenant = text(incomes, r, 1);
    const aptRef = apt ? text(incomes, r, apt) : fileApartment!;
    // Blank tenant: the second lot of a lease on the row above ("Covaci10_L2"). "vacant ...": no lease.
    if (!tenant || !aptRef || /^vacant/i.test(tenant) || /^incomes$/i.test(tenant)) continue;
    if (!text(incomes, r, col.rent) && !isoDate(incomes.value(r, col.start))) continue;   // a note line, not a lease
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
      notes: itaiHebrew(text(incomes, r, notesCol)), errors, hidden: incomes.hidden(r),
    });
  }
  return out;
}

export function parseItai(book: Book, fileName = ''): ParseResult {
  const incomes = book.sheet(/^incomes$/i);
  const expenses = book.sheet(/^expenses$/i);
  if (!incomes || !expenses) throw new FormatError('הקובץ לא בפורמט המוכר: צריכים להיות בו לפחות הגיליונות Incomes ו-Expenses');
  const paidSheets = book.sheets.filter((g) => /paid to owner/i.test(g.sheet));
  const received = book.sheet(/^received from owner$/i);
  const file = itaiFileName(fileName);

  const rows: ParsedRow[] = [];
  const warnings: string[] = [];
  const checks: string[] = [];
  let latest = '';
  let owner = '';
  // Itai's balance with the owner, piece by piece, for the equation against Totals.
  const sums = { eden: 0, expenses: 0, paid: 0, vat: 0, repaid: 0 };

  // `source` is Itai's own text. The description shown is its Hebrew translation, so the
  // fingerprint (and the "changed since" comparison) use the original, which a better
  // translation never changes.
  const push = (row: Omit<ParsedRow, 'fingerprint'> & { counterparty: string; source: string }) => {
    const p = row.proposed!;
    if (p.occurred_on > latest) latest = p.occurred_on;
    const amount = p.entries[0].amount;
    const { counterparty, source, ...rest } = row;
    const translated = p.description !== source && source ? [`במקור: ${source}`] : [];
    // Two months are often paid on the same day for the same amount; the month and
    // the text tell them apart.
    rows.push({
      ...rest, issues: [...rest.issues, ...translated], raw: { ...rest.raw, source_text: source },
      fingerprint: [ADAPTER, row.property.ref, p.category, p.occurred_on, p.period, amount, counterparty, source].join('|'),
    });
  };
  const month = (d: string) => `${d.slice(0, 8)}01`;
  const apartmentOf = (g: Grid, r: number, c: number) => (c ? text(g, r, c) : file.apartment ?? '');

  // Incomes: the receipts table starts at the row whose first cell is "amount received (RON)".
  const start = headerRow(incomes, /^amount received \(RON\)$/i);
  if (!start) throw new FormatError('הקובץ לא בפורמט המוכר: בגיליון Incomes לא נמצאה הכותרת "amount received (RON)"');
  const ic = headerCols(incomes, start);
  const col = {
    amount: 1, date: need(ic, 'date', 'Incomes'), what: need(ic, 'explanation', 'Incomes'), period: need(ic, 'period', 'Incomes'),
    client: need(ic, 'client', 'Incomes'), to: need(ic, 'beneficiary', 'Incomes'), apt: ic.apartment ?? 0,
  };
  if (!col.apt && !file.apartment) throw new FormatError('הקובץ לא בפורמט המוכר: בגיליון Incomes אין עמודת "apartment", ושם הקובץ לא מציין דירה');
  // The owner: from the file name; else the first receipt that went to the owner.
  owner = file.owner;
  for (let r = start + 1; r <= incomes.rows && !owner; r++) if (!/^(eden|-)?$/i.test(text(incomes, r, col.to))) owner = text(incomes, r, col.to);
  const anchorRef = file.apartment ?? '';

  let lastSeen = '';
  for (let r = start + 1; r <= incomes.rows; r++) {
    const amount = num(incomes.value(r, col.amount));
    if (amount === null || !amount) continue;
    const what = text(incomes, r, col.what).toLowerCase();
    const forMonth = isoDate(incomes.value(r, col.period));
    const date = isoDate(incomes.value(r, col.date));
    const aptRef = apartmentOf(incomes, r, col.apt);
    const tenant = text(incomes, r, col.client);
    const toEden = /^eden$/i.test(text(incomes, r, col.to));
    const hint = itaiHint(aptRef, owner) ?? { ref: aptRef || '(ללא דירה)', unit: '' };
    // "DUE rent" without a date: expected, not received. Itai leaves it out; so do we.
    if (/^due\b/.test(what)) {
      rows.push({
        ref: `Incomes!R${r}`, property: hint, kind: 'צפוי, טרם התקבל', proposed: null, fingerprint: null, errors: [],
        issues: [`${itaiHebrew(what)}${forMonth ? ` עבור ${monthHe(forMonth)}` : ''}: ${round2(amount)} lei מ-${tenant}. לא נרשם עד שיתקבל`],
        raw: { sheet: 'Incomes', row: r, property_ref: hint.ref, tenant, explanation: what, description: `${what} ${round2(amount)} lei` },
      });
      continue;
    }
    const issues: string[] = [];
    const errors: string[] = [];
    // Older rows often have only the month the rent was for; that is good enough.
    if (!date && forMonth) issues.push('אין תאריך קבלה בקובץ; נרשם לפי חודש השכירות');
    if (!date && !forMonth) errors.push('חסר תאריך: נרשם לפי השורה הקודמת');
    const on = date ?? forMonth ?? (lastSeen || '2024-01-01');
    lastSeen = on;
    // "rent", "eden_rent", "rent_owner", "deposit_eden", "penalties_owner": the type, with who got it.
    const base = what.replace(/^eden_|_(eden|owner)$/g, '');
    const penalty = base === 'penalties';
    const category = base === 'rent' ? 'rent' : base === 'deposit' ? 'deposit' : base === 'utilities' ? 'utilities' : 'other';
    if (category === 'other' && !penalty) errors.push(`סוג תקבול לא מוכר: "${what || 'ריק'}"`);
    const label = penalty ? 'קנס / פיצוי' : { rent: 'שכירות', deposit: 'פיקדון', utilities: 'החזר חשבונות', other: 'תקבול' }[category]!;
    const rentMonth = forMonth && category !== 'deposit' ? ` עבור ${monthHe(forMonth)}` : '';
    // Who received it decides where it goes: the owner's bank, Itai's balance, or the deposit Itai holds.
    const kind = !toEden ? 'client_bank' : category === 'deposit' ? 'deposit_held' : 'manager_cash';
    if (kind === 'manager_cash') sums.eden += amount;
    issues.push(toEden ? 'התקבל אצל איתי (eden)' : 'התקבל אצל הבעלים');
    push({
      ref: `Incomes!R${r}`, property: hint, kind: `${label}${toEden ? ' (אצל איתי)' : ''}`,
      proposed: {
        occurred_on: on, period: month(forMonth ?? on), category,
        description: `${category === 'other' && !penalty ? itaiHebrew(what) || label : label}${rentMonth} מ-${tenant}`,
        entries: [{ amount: round2(amount), currency: 'RON', account: { kind, holder: kind === 'client_bank' ? 'beneficiary' : 'source' } }],
      },
      issues, errors, counterparty: tenant, source: `${what} ${forMonth ?? ''}`.trim(),
      raw: { sheet: 'Incomes', row: r, property_ref: hint.ref, tenant, explanation: what, period: forMonth, received_by: toEden ? 'eden' : 'owner' },
    });
  }

  // Costs of the owner rather than of one apartment ("all", "none") and his transfers
  // are booked on his first apartment, so every lei stays in the balance.
  const anchor = (anchorRef ? itaiHint(anchorRef, owner) : null) ?? rows.find((x) => x.property.unit || x.property.street)?.property;

  // Expenses paid for the owner, by Itai's office or out of the rent it holds. Itai
  // counts every one of them, whoever's name is in "paid by".
  const eh = headerRow(expenses, /^amount paid \(RON\)$/i, 6);
  if (!eh) throw new FormatError('הקובץ לא בפורמט המוכר: בגיליון Expenses לא נמצאה הכותרת "amount paid (RON)"');
  const ec = headerCols(expenses, eh);
  const e = {
    date: need(ec, 'date', 'Expenses'), to: need(ec, 'beneficiary', 'Expenses'), what: need(ec, 'explanation', 'Expenses'),
    by: need(ec, 'paid by', 'Expenses'), apt: ec.apartment ?? 0,
  };
  lastSeen = '';
  for (let r = eh + 1; r <= expenses.rows; r++) {
    const amount = num(expenses.value(r, 1));
    if (amount === null || !amount) continue;
    const date = isoDate(expenses.value(r, e.date));
    const what = text(expenses, r, e.what);
    sums.expenses += amount;
    const aptRef = apartmentOf(expenses, r, e.apt);
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
    const he = itaiHebrew(what);
    push({
      ref: `Expenses!R${r}`, property: hint ?? anchor ?? { ref: aptRef || '(ללא דירה)', unit: '' },
      kind: category === 'mgmt_fee' ? 'דמי ניהול' : category === 'tax_withheld' ? 'מס במקור' : 'הוצאה',
      proposed: { occurred_on: on, period: month(on), category, description: he, entries: [{ amount: -round2(amount), currency: 'RON', memo: he, account: { kind: 'manager_cash', holder: 'source' } }] },
      issues, errors, counterparty: text(expenses, r, e.to), source: what,
      raw: { sheet: 'Expenses', row: r, property_ref: (hint ?? anchor)?.ref ?? aptRef, paid_to: text(expenses, r, e.to), paid_by: text(expenses, r, e.by) },
    });
  }

  const property = anchor ?? { ref: '(ללא דירה)', unit: '' };
  const noAnchor = anchor ? [] : ['לא נמצאה דירה בקובץ לרישום התנועה'];

  // Rent Itai passed on to the owner: from his balance to the owner's bank.
  for (const g of paidSheets) {
    const ph = headerRow(g, /^amount paid( \(RON\))?$/i, 6);
    if (!ph) throw new FormatError(`הקובץ לא בפורמט המוכר: בגיליון "${g.sheet}" לא נמצאה הכותרת "amount paid"`);
    const pc = headerCols(g, ph);
    const dc = need(pc, 'date', g.sheet); const wc = need(pc, 'explanation', g.sheet);
    for (let r = ph + 1; r <= g.rows; r++) {
      const amount = num(g.value(r, 1));
      if (amount === null || !amount) continue;
      const date = isoDate(g.value(r, dc));
      const what = text(g, r, wc);
      sums.paid += amount;
      const errors = [...noAnchor, ...(date ? [] : ['חסר תאריך: התשלום לבעלים אולי עוד לא בוצע. לבדוק מול איתי; בלי השורה נוסחת האיזון לא תתאים'])];
      const on = date ?? latest;
      const note = text(g, r, (pc['paid by'] ?? 6) + 1);
      push({
        ref: `${g.sheet}!R${r}`, property, kind: 'תשלום לבעלים',
        proposed: {
          occurred_on: on, period: month(on), category: 'transfer', description: `איתי העביר לבעלים: ${itaiHebrew(what)}`,
          entries: [
            { amount: -round2(amount), currency: 'RON', account: { kind: 'manager_cash', holder: 'source' } },
            { amount: round2(amount), currency: 'RON', account: { kind: 'client_bank', holder: 'beneficiary' } },
          ],
        },
        issues: note ? [itaiHebrew(note)] : [], errors, counterparty: 'paid to owner', source: what,
        raw: { sheet: g.sheet, row: r, property_ref: property.ref },
      });
    }
  }

  // The owner paying Itai back: from the owner's bank to Itai, VAT included.
  if (received) {
    const rh = headerRow(received, /^amount received/i, 6);
    for (let r = rh + 1; rh && r <= received.rows; r++) {
      const amount = num(received.value(r, 1));
      if (amount === null || !amount) continue;
      const date = isoDate(received.value(r, 2));
      const details = text(received, r, 4);
      const invoice = text(received, r, 3);
      const vat = itaiVat(date, details);
      const vatPart = round2(amount - amount / (1 + vat));
      sums.repaid += amount; sums.vat += vatPart;
      const errors = [...noAnchor, ...(date ? [] : ['חסר תאריך: לבדוק מתי הבעלים שילם. לא לסמן "לא לרשום": בלי השורה נוסחת האיזון מול איתי לא תתאים'])];
      const on = date ?? latest;
      const raw = { sheet: 'Received from owner', row: r, property_ref: property.ref, invoice, details };
      push({
        ref: `Received!R${r}`, property, kind: 'החזר מהבעלים לאיתי',
        proposed: {
          occurred_on: on, period: month(on), category: 'transfer',
          description: `החזר לאיתי${details ? ` על ${itaiHebrew(details)}` : ''}${invoice ? ` (חשבונית ${invoice})` : ''}`,
          entries: [
            { amount: round2(amount), currency: 'RON', account: { kind: 'manager_cash', holder: 'source' } },
            { amount: -round2(amount), currency: 'RON', account: { kind: 'client_bank', holder: 'beneficiary' } },
          ],
        },
        issues: [], errors, counterparty: `invoice ${invoice}`, source: details, raw,
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
        issues: [`ההחזר ${round2(amount)} lei כולל מע"מ; ${round2(amount - vatPart)} lei מכסים הוצאות`], errors, counterparty: `vat ${invoice}`, source: details, raw,
      });
    }
  }
  if (!owner) throw new FormatError('לא נמצא שם הבעלים, לא בשם הקובץ ולא בעמודת beneficiary');

  // The balance equation: Itai's balance with the owner (+ he owes the owner, − the owner
  // owes him), ours against his Totals sheet.
  const ours = round2(sums.eden - sums.expenses - sums.paid + sums.repaid - sums.vat);
  const totals = book.sheet(/^totals$/i);
  let expected: number | null = null;
  for (let r = 1; totals && r <= totals.rows; r++) {
    const label = text(totals, r, 1).toLowerCase();
    const value = cellNumber(totals, r, 2);
    if (value === null) continue;
    if (/remaining to pay owner/.test(label)) expected = (expected ?? 0) + value;
    if (/remaining to receive from owner/.test(label)) expected = (expected ?? 0) - value;
  }
  const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const equation = [
    sums.eden ? `שכירות שהתקבלה אצל איתי ${fmt(sums.eden)}` : '', `− הוצאות ${fmt(sums.expenses)}`,
    sums.paid ? `− תשלומים לבעלים ${fmt(sums.paid)}` : '', sums.repaid ? `+ החזרים מהבעלים ${fmt(sums.repaid)} − מע"מ ${fmt(sums.vat)}` : '',
  ].filter(Boolean).join(' ').replace(/^− /, '−') + ` = ${fmt(ours)} lei`;
  const meaning = (n: number) => (Math.abs(n) < 0.5 ? 'החשבון מאוזן' : n > 0 ? 'איתי חייב לבעלים' : 'הבעלים חייב לאיתי');
  if (expected === null) warnings.push(`לא נמצאה בגיליון Totals שורת "Total remaining", ולכן אין בדיקת איזון. לפי השורות: ${equation} (${meaning(ours)})`);
  else if (Math.abs(expected - ours) > 1) warnings.push(`נוסחת האיזון לא מתאימה: ${equation}, אבל לפי Totals של איתי ${fmt(round2(expected))} lei`);
  else checks.push(`נוסחת האיזון מול איתי מתאימה: ${equation}, ולפי Totals ${fmt(round2(expected))} lei (${meaning(expected)})`);

  if (!rows.length) warnings.push('לא נמצאו שורות בקובץ');
  return {
    period: month(latest || '2026-01-01'), rows, warnings, checks, scope: owner,
    leases: parseItaiLeases(incomes, start, owner, file.apartment),
  };
}
