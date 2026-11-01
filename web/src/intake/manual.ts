// Manual forms for managers who report over WhatsApp, without a file (SPEC §5).
// The office types what the screenshots say; these functions turn it into the same
// rows an adapter produces, so the report goes through the usual review and approval.
//
// Yarach (Odessa): ~10 daily UAH transfers a month to Gershon, who holds the rent for
// us. What arrived in the month is split between Yarach's apartments by each one's
// share of the expected rent (rent_schedule); the rest stays open (SPEC decision 7).
//
// Liana (Alliance, Batumi): one monthly amount per apartment in GEL. She keeps her fee
// (10% by default, from the management agreement) and pays the rest to the client's bank.

import { lastDay, round2 } from './util.ts';
import { FormatError, type ParseResult, type ParsedRow, type ProposedEntry } from './types.ts';

export interface ManagedUnit {
  id: string;
  ref: string;          // "Arcadia 106": how the review screen names the row
  owner?: string;
  expected?: number;    // Yarach: expected monthly rent in UAH for the month
  feePct?: number;      // Liana: her share, from the management agreement
}

export interface Transfer { on: string; amount: number; note?: string }
export interface YarachForm { transfers: Transfer[] }
export interface LianaLine { property_id: string; gross: number }
export interface LianaForm { paid_on?: string; lines: LianaLine[] }

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const inMonth = (on: string, period: string) => on.slice(0, 7) === period.slice(0, 7);

// Splits `total` by weights, in cents, so the parts add up exactly. The cents left
// over by rounding go to the largest weights first.
export function proRata(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const cents = Math.round(total * 100);
  const raw = weights.map((w) => (cents * w) / sum);
  const parts = raw.map(Math.floor);
  let left = cents - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r), w: weights[i] }))
    .sort((a, b) => b.frac - a.frac || b.w - a.w || a.i - b.i);
  for (const o of order) { if (left <= 0) break; parts[o.i] += 1; left -= 1; }
  return parts.map((c) => c / 100);
}

export function buildYarach(period: string, form: YarachForm, units: ManagedUnit[], gershonId: string): ParseResult {
  const transfers = form.transfers.filter((t) => t.amount);
  if (!transfers.length) throw new FormatError('לא הוזנו העברות');
  for (const t of transfers) {
    if (!t.on) throw new FormatError('לכל העברה צריך תאריך');
    if (!inMonth(t.on, period)) throw new FormatError(`ההעברה מ-${t.on.split('-').reverse().join('.')} אינה בחודש הדוח`);
    if (t.amount < 0) throw new FormatError('סכום העברה לא יכול להיות שלילי');
  }
  const priced = units.filter((u) => (u.expected ?? 0) > 0);
  if (!priced.length) throw new FormatError('לאף דירה של ירח אין שכירות צפויה לחודש הזה. מגדירים אותה ברשימת הדירות שבטופס');

  const total = round2(transfers.reduce((a, t) => a + t.amount, 0));
  const expected = round2(priced.reduce((a, u) => a + u.expected!, 0));
  const parts = proRata(total, priced.map((u) => u.expected!));
  const over = total > expected + 0.5;
  const on = lastDay(period);
  const month = period.slice(0, 7).split('-').reverse().join('.');

  const rows: ParsedRow[] = priced.map((u, i) => {
    const amount = parts[i];
    const open = round2(u.expected! - amount);
    return {
      ref: `yarach:${u.id}`, property: { ref: u.ref, unit: '', owner: u.owner, id: u.id }, kind: 'שכירות (חלק יחסי)',
      proposed: {
        occurred_on: on, period, category: 'rent', description: `שכירות ${month}, חלק יחסי מההעברות של ירח לגרשון`,
        entries: [{ amount, currency: 'UAH', memo: `${fmt(u.expected!)} ₴ צפוי, ${transfers.length} העברות`, account: { kind: 'rent_pool', holder: gershonId } }],
      },
      fingerprint: ['yarach', u.id, period, amount].join('|'),
      issues: [`צפוי ${fmt(u.expected!)} ₴, התקבל ${fmt(amount)} ₴${open > 0 ? `, פתוח ${fmt(open)} ₴` : ''}`],
      errors: over ? [`בחודש הזה התקבל יותר מהצפוי (${fmt(total)} ₴ מול ${fmt(expected)} ₴). לבדוק את ההעברות ואת השכירות הצפויה`] : [],
      raw: { row: i + 1, property_ref: u.ref, owner: u.owner, amount, expected: u.expected, description: `חלק ${fmt(u.expected!)}/${fmt(expected)}` },
    };
  });

  const skipped = units.filter((u) => !((u.expected ?? 0) > 0));
  const warnings = [
    ...(skipped.length ? [`בלי שכירות צפויה, ולכן לא קיבלו חלק: ${skipped.map((u) => u.ref).join(', ')}`] : []),
    ...(over ? [`התקבל יותר מהצפוי: ${fmt(total)} ₴ מול ${fmt(expected)} ₴`] : []),
  ];
  return {
    period, rows, warnings, scope: period.slice(0, 7),
    checks: [
      `${transfers.length} העברות, סה"כ ${fmt(total)} ₴, מתוך ${fmt(expected)} ₴ צפוי (${Math.round((total / expected) * 100)}%)`,
      `הסכום חולק בין ${priced.length} דירות לפי השכירות הצפויה של כל אחת, ונכנס לקופת השכירות אצל גרשון`,
    ],
  };
}

export function buildLiana(period: string, form: LianaForm, units: ManagedUnit[]): ParseResult {
  const byId = new Map(units.map((u) => [u.id, u]));
  const lines = form.lines.filter((l) => l.gross);
  if (!lines.length) throw new FormatError('לא הוזנו סכומים');
  const on = form.paid_on || lastDay(period);
  if (!inMonth(on, period)) throw new FormatError('תאריך התשלום אינו בחודש הדוח');
  const month = period.slice(0, 7).split('-').reverse().join('.');

  const rows: ParsedRow[] = [];
  let gross = 0; let fees = 0;
  lines.forEach((l, i) => {
    const u = byId.get(l.property_id);
    if (!u) throw new FormatError('אחת הדירות בטופס אינה מנוהלת על ידי ליאנה');
    if (l.gross < 0) throw new FormatError(`${u.ref}: סכום שלילי`);
    const pct = u.feePct ?? 10;
    const fee = round2((l.gross * pct) / 100);
    const net = round2(l.gross - fee);
    gross += l.gross; fees += fee;
    const property = { ref: u.ref, unit: '', owner: u.owner, id: u.id };
    const row = (n: number, kind: string, category: string, description: string, amount: number, entries: ProposedEntry[]): ParsedRow => ({
      ref: `liana:${u.id}:${n}`, property, kind, issues: [], errors: [],
      proposed: { occurred_on: on, period, category, description, entries },
      fingerprint: ['liana', u.id, period, category, amount].join('|'),
      raw: { row: i * 3 + n, property_ref: u.ref, owner: u.owner, amount, description },
    });
    rows.push(
      row(1, 'הכנסה', 'rent', `הכנסה ${month} (ליאנה)`, l.gross,
        [{ amount: l.gross, currency: 'GEL', account: { kind: 'manager_cash', holder: 'source' } }]),
      row(2, `עמלה ${pct}%`, 'mgmt_fee', `עמלת ניהול לליאנה ${pct}%`, fee, [
        { amount: -fee, currency: 'GEL', account: { kind: 'manager_cash', holder: 'source' } },
        { amount: fee, currency: 'GEL', external: 'source' },
      ]),
      row(3, 'העברה לבנק הלקוח', 'transfer', `העברה לבנק הלקוח ${month}`, net, [
        { amount: -net, currency: 'GEL', account: { kind: 'manager_cash', holder: 'source' } },
        { amount: net, currency: 'GEL', account: { kind: 'client_bank', holder: 'beneficiary' } },
      ]),
    );
  });
  const missing = units.filter((u) => !lines.some((l) => l.property_id === u.id));
  return {
    period, rows, scope: period.slice(0, 7),
    warnings: missing.length ? [`בלי סכום החודש: ${missing.map((u) => u.ref).join(', ')}`] : [],
    checks: [`${lines.length} דירות, הכנסה ${fmt(round2(gross))} ₾, עמלה ${fmt(round2(fees))} ₾, לבנקים ${fmt(round2(gross - fees))} ₾`],
  };
}
