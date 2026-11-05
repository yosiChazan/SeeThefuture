// Management statistics from the ledger (SPEC decision 96). Pure, tested.
//
// Only posted transactions count, and only their entries on accounts (the clients' and
// the managers' money); a transfer, a currency exchange, a deposit held or an opening
// balance is money moving, not income or expense. Sums stay per currency: money is never
// converted (CLAUDE.md), so every figure is shown in its own currency.

export type Flow = 'income' | 'expense';
const INCOME = new Set(['rent', 'hotel_share']);
const NOT_COUNTED = new Set(['transfer', 'fx', 'deposit', 'opening_balance', 'purchase_installment', 'deal_fee']);

export function flowOf(category: string): Flow | null {
  if (NOT_COUNTED.has(category)) return null;
  return INCOME.has(category) ? 'income' : 'expense';
}

export interface StatEntry { amount: number; currency: string; property_id: string | null; period: string; category: string }
export interface MonthRow { period: string; gross: number; expenses: number; net: number }
export interface CityRow { city: string; currency: string; units: number; earning: number; gross: number; expenses: number; net: number; months: number; perUnit: number }
export interface CategoryRow { category: string; amount: number }

const round = (n: number) => Math.round(n * 100) / 100;

// Per currency, per month: gross income, expenses (a positive number) and net.
export function monthly(entries: StatEntry[]): Map<string, MonthRow[]> {
  const out = new Map<string, Map<string, MonthRow>>();
  for (const e of entries) {
    const flow = flowOf(e.category);
    if (!flow) continue;
    const months = out.get(e.currency) ?? out.set(e.currency, new Map()).get(e.currency)!;
    const row = months.get(e.period) ?? months.set(e.period, { period: e.period, gross: 0, expenses: 0, net: 0 }).get(e.period)!;
    if (flow === 'income') row.gross += e.amount; else row.expenses -= e.amount;
    row.net += e.amount;
  }
  return new Map([...out].map(([cur, m]) => [cur, [...m.values()].sort((a, b) => a.period.localeCompare(b.period))
    .map((r) => ({ period: r.period, gross: round(r.gross), expenses: round(r.expenses), net: round(r.net) }))]));
}

// Per city and currency. "units": apartments in the city that are not sold. The average
// (decision 98) counts only apartments that are rented now (rented or short-term) and had
// income: perUnit = their income ÷ how many of them ÷ months with income in that city.
// Gross, expenses and net stay the whole city's.
export function byCity(entries: StatEntry[], cityOf: Map<string, string>, unitsIn: Map<string, number>, rented?: Set<string>): CityRow[] {
  const acc = new Map<string, { city: string; currency: string; gross: number; expenses: number; rentedGross: number; earning: Set<string>; months: Set<string> }>();
  for (const e of entries) {
    const flow = flowOf(e.category);
    const city = e.property_id ? cityOf.get(e.property_id) : undefined;
    if (!flow || !city) continue;
    const k = `${city}|${e.currency}`;
    const a = acc.get(k) ?? acc.set(k, { city, currency: e.currency, gross: 0, expenses: 0, rentedGross: 0, earning: new Set(), months: new Set() }).get(k)!;
    if (flow === 'expense') { a.expenses -= e.amount; continue; }
    a.gross += e.amount;
    if (rented && !rented.has(e.property_id!)) continue;
    a.rentedGross += e.amount;
    if (e.amount > 0) { a.earning.add(e.property_id!); a.months.add(e.period); }
  }
  return [...acc.values()].map((a) => ({
    city: a.city, currency: a.currency, units: unitsIn.get(a.city) ?? 0, earning: a.earning.size,
    gross: round(a.gross), expenses: round(a.expenses), net: round(a.gross - a.expenses), months: a.months.size,
    perUnit: a.earning.size && a.months.size ? round(a.rentedGross / a.earning.size / a.months.size) : 0,
  })).sort((x, y) => x.currency.localeCompare(y.currency) || y.gross - x.gross);
}

// Occupancy per city (decision 98). Sold apartments are out; apartments under construction
// or used by their owners cannot be rented, so "not rented" and its percent count only the
// apartments that can be.
export interface OccupancyRow { city: string; total: number; construction: number; ownerUse: number; rentable: number; rented: number; notRented: number; notRentedPct: number }
export function occupancy(props: { city: string; status: string }[]): OccupancyRow[] {
  const m = new Map<string, OccupancyRow>();
  const add = (city: string, status: string) => {
    const r = m.get(city) ?? m.set(city, { city, total: 0, construction: 0, ownerUse: 0, rentable: 0, rented: 0, notRented: 0, notRentedPct: 0 }).get(city)!;
    r.total++;
    if (status === 'under_construction') r.construction++;
    else if (status === 'owner_use') r.ownerUse++;
    else { r.rentable++; if (status === 'rented' || status === 'short_term') r.rented++; else r.notRented++; }
  };
  for (const p of props) if (p.status !== 'sold') add(p.city, p.status);
  return [...m.values()].map((r) => ({ ...r, notRentedPct: r.rentable ? Math.round((r.notRented / r.rentable) * 1000) / 10 : 0 }))
    .sort((a, b) => b.total - a.total);
}

// The average monthly rent in the contracts of apartments rented now, per city and currency.
export function contractRent(props: { city: string; status: string; leases: { start_date: string | null; end_date: string | null; rent_amount: number | null; rent_currency: string | null }[] }[], today: string) {
  const m = new Map<string, { city: string; currency: string; sum: number; n: number }>();
  for (const p of props) {
    if (p.status !== 'rented') continue;
    const l = p.leases.find((x) => x.rent_amount && x.rent_currency && (!x.start_date || x.start_date <= today) && (!x.end_date || x.end_date >= today));
    if (!l) continue;
    const k = `${p.city}|${l.rent_currency}`;
    const r = m.get(k) ?? m.set(k, { city: p.city, currency: l.rent_currency!, sum: 0, n: 0 }).get(k)!;
    r.sum += Number(l.rent_amount); r.n++;
  }
  return [...m.values()].map((r) => ({ city: r.city, currency: r.currency, leases: r.n, avg: round(r.sum / r.n) }));
}

// Expenses by category within one currency, largest first.
export function expensesByCategory(entries: StatEntry[], currency: string): CategoryRow[] {
  const m = new Map<string, number>();
  for (const e of entries) if (e.currency === currency && flowOf(e.category) === 'expense') m.set(e.category, (m.get(e.category) ?? 0) - e.amount);
  return [...m].map(([category, amount]) => ({ category, amount: round(amount) })).filter((r) => r.amount !== 0).sort((a, b) => b.amount - a.amount);
}

// Quiet apartments (decision 97): apartments expected to earn (rented or short-term) with no
// income in the last `n` months that have data. Reports come late and per country, so the
// window ends at the country's latest month with any income, not at today; a country with
// no approved income at all is not judged.
export interface QuietRow { id: string; country: string; lastIncome: string | null }
export function quiet(entries: (StatEntry & { country: string })[], props: { id: string; country: string; expected: boolean }[], n: number): { rows: QuietRow[]; windowEnd: Map<string, string> } {
  const latest = new Map<string, string>();
  const last = new Map<string, string>();
  for (const e of entries) {
    if (flowOf(e.category) !== 'income' || e.amount <= 0) continue;
    if ((latest.get(e.country) ?? '') < e.period) latest.set(e.country, e.period);
    if (e.property_id && (last.get(e.property_id) ?? '') < e.period) last.set(e.property_id, e.period);
  }
  const start = (end: string) => { const d = new Date(`${end}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - (n - 1)); return d.toISOString().slice(0, 10); };
  const rows = props.filter((p) => p.expected && latest.has(p.country) && (last.get(p.id) ?? '') < start(latest.get(p.country)!))
    .map((p) => ({ id: p.id, country: p.country, lastIncome: last.get(p.id) ?? null }))
    .sort((a, b) => (a.lastIncome ?? '').localeCompare(b.lastIncome ?? ''));
  return { rows, windowEnd: latest };
}

// The same month a year earlier, and the change in percent (null when there is nothing to compare).
export const yearBefore = (period: string) => `${Number(period.slice(0, 4)) - 1}${period.slice(4)}`;
export function change(now: number, before: number | undefined): number | null {
  return before ? Math.round(((now - before) / Math.abs(before)) * 1000) / 10 : null;
}
// Totals of the last `n` months with data against the same months a year earlier.
export function trend(rows: MonthRow[], n: number): { now: number; before: number | null; months: string[] } | null {
  if (!rows.length) return null;
  const by = new Map(rows.map((r) => [r.period, r]));
  const recent = rows.slice(-n);
  const before = recent.map((r) => by.get(yearBefore(r.period)));
  return {
    now: round(recent.reduce((a, r) => a + r.gross, 0)),
    before: before.every(Boolean) ? round(before.reduce((a, r) => a + r!.gross, 0)) : null,
    months: recent.map((r) => r.period),
  };
}
