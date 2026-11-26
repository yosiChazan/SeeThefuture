// A client's statement for a period (SPEC decision 208), per account (who holds the money, in what
// currency): the balance before the period, then either one line per month (income, expenses,
// net) or every entry with the balance after it, and the balance at the end. Amounts are never
// converted: each account stays in its own currency. Pure, tested.

export interface StatementAccount { id: string; title: string; currency: string }
export interface StatementEntry { account_id: string; amount: number; on: string; label: string; place: string | null }
export interface MonthLine { month: string; income: number; expenses: number; net: number; balance: number }
export interface DetailLine { on: string; label: string; place: string | null; amount: number; balance: number }
export interface AccountStatement {
  account: StatementAccount; opening: number; closing: number; income: number; expenses: number;
  months: MonthLine[]; lines: DetailLine[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function buildStatement(accounts: StatementAccount[], entries: StatementEntry[], from: string, to: string): AccountStatement[] {
  return accounts.map((account) => {
    const mine = entries.filter((e) => e.account_id === account.id).sort((a, b) => a.on.localeCompare(b.on));
    const opening = r2(mine.filter((e) => e.on < from).reduce((a, e) => a + e.amount, 0));
    const inPeriod = mine.filter((e) => e.on >= from && e.on <= to);
    let balance = opening;
    const lines = inPeriod.map((e) => { balance = r2(balance + e.amount); return { on: e.on, label: e.label, place: e.place, amount: e.amount, balance }; });
    const byMonth = new Map<string, { income: number; expenses: number }>();
    for (const e of inPeriod) {
      const m = byMonth.get(e.on.slice(0, 7)) ?? byMonth.set(e.on.slice(0, 7), { income: 0, expenses: 0 }).get(e.on.slice(0, 7))!;
      if (e.amount >= 0) m.income += e.amount; else m.expenses += e.amount;
    }
    let running = opening;
    const months = [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([month, m]) => {
      running = r2(running + m.income + m.expenses);
      return { month, income: r2(m.income), expenses: r2(m.expenses), net: r2(m.income + m.expenses), balance: running };
    });
    const income = r2(inPeriod.filter((e) => e.amount >= 0).reduce((a, e) => a + e.amount, 0));
    const expenses = r2(inPeriod.filter((e) => e.amount < 0).reduce((a, e) => a + e.amount, 0));
    return { account, opening, closing: r2(opening + income + expenses), income, expenses, months, lines };
  }).filter((s) => s.opening !== 0 || s.lines.length > 0);
}
