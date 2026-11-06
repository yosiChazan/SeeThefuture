// Cash boxes (SPEC decision 112): what a box should hold. Pure, tested.
// Every sum is per currency; nothing is converted.

export interface CashMovement { id: string; occurred_on: string; amount: number; currency: string; kind: string; party_id: string | null; party_name: string | null; notes: string | null; created_by: string | null }

export const KIND_HE: Record<string, string> = {
  from_manager: 'התקבל ממנהל', to_client: 'הועבר ללקוח', expense: 'הוצאה', income: 'הכנסה', transfer: 'העברה בין קופות', other: 'אחר',
};

export interface BoxSummary {
  currency: string;
  fromManagers: { who: string; amount: number }[];   // in, by manager
  received: number;      // everything received from managers
  toClients: number;     // everything handed to clients (positive)
  expected: number;      // received − toClients: what the box should hold by that rule
  others: number;        // expenses, income, transfers and other, signed
  balance: number;       // every movement: expected + others
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// What flows in from approved reports on its own (a linked manager's cash), per currency.
export interface AutoIn { who: string; currency: string; amount: number }

export function summarize(ms: CashMovement[], nameOf: (m: CashMovement) => string, auto: AutoIn[] = []): BoxSummary[] {
  const by = new Map<string, CashMovement[]>();
  for (const m of ms) by.set(m.currency, [...(by.get(m.currency) ?? []), m]);
  for (const a of auto) if (!by.has(a.currency)) by.set(a.currency, []);
  return [...by].map(([currency, list]) => {
    const managers = new Map<string, number>();
    for (const a of auto) if (a.currency === currency) managers.set(a.who, (managers.get(a.who) ?? 0) + a.amount);
    let toClients = 0, others = 0;
    for (const m of list) {
      if (m.kind === 'from_manager') managers.set(nameOf(m), (managers.get(nameOf(m)) ?? 0) + Number(m.amount));
      else if (m.kind === 'to_client') toClients -= Number(m.amount);
      else others += Number(m.amount);
    }
    const received = [...managers.values()].reduce((a, b) => a + b, 0);
    return {
      currency, fromManagers: [...managers].map(([who, amount]) => ({ who, amount: r2(amount) })).sort((a, b) => b.amount - a.amount),
      received: r2(received), toClients: r2(toClients), expected: r2(received - toClients), others: r2(others), balance: r2(received - toClients + others),
    };
  }).sort((a, b) => a.currency.localeCompare(b.currency));
}
