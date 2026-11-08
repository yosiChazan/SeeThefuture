// Cash boxes (SPEC decisions 112–114): what a box should hold, and how each sum sent to the
// office was divided. Pure, tested. Every sum is per currency; nothing is converted.

export interface CashMovement {
  id: string; occurred_on: string; amount: number; currency: string; kind: string; party_id: string | null; party_name: string | null;
  notes: string | null; created_by: string | null; parent_id?: string | null; transaction_id?: string | null; mirror_of?: string | null;
  fx_rate?: number | null; fx_transaction_id?: string | null;
}

export const KIND_HE: Record<string, string> = {
  from_manager: 'התקבל ממנהל', to_office: 'הועבר אלינו (למשרד)', to_client: 'ללקוח', office_fee: 'למשרד (עמלות)',
  expense: 'הוצאה', income: 'הכנסה', transfer: 'העברה בין קופות', other: 'אחר',
};

// fx: a currency conversion in the box's accounts (decision 124), shown on its own line, not
// as money received from the managers.
export interface AutoIn { who: string; currency: string; amount: number; fx?: boolean }

export interface BoxSummary {
  currency: string;
  fromManagers: { who: string; amount: number }[];
  received: number;      // from the managers: reports on their own, plus what was entered
  converted: number;     // conversions: hryvnia out (negative), dollars/euros/shekels in (positive)
  sentToOffice: number;  // sums sent to us (positive)
  toClients: number;     // paid to clients straight from the box, not through a sum to us
  expected: number;      // received ± converted − sent to us − paid straight to clients
  others: number;        // expenses, income, transfers and other, signed
  balance: number;       // expected + others
}

const r2 = (n: number) => Math.round(n * 100) / 100 + 0;   // "+ 0" turns -0 into 0

export function summarize(ms: CashMovement[], nameOf: (m: CashMovement) => string, auto: AutoIn[] = []): BoxSummary[] {
  const top = ms.filter((m) => !m.parent_id);   // a sum's parts are its breakdown, not more money
  const by = new Map<string, CashMovement[]>();
  for (const m of top) by.set(m.currency, [...(by.get(m.currency) ?? []), m]);
  for (const a of auto) if (!by.has(a.currency)) by.set(a.currency, []);
  return [...by].map(([currency, list]) => {
    const managers = new Map<string, number>();
    let converted = 0;
    for (const a of auto) if (a.currency === currency) {
      if (a.fx) converted += a.amount;
      else managers.set(a.who, (managers.get(a.who) ?? 0) + a.amount);
    }
    let sentToOffice = 0, toClients = 0, others = 0;
    for (const m of list) {
      const n = Number(m.amount);
      if (m.kind === 'from_manager') managers.set(nameOf(m), (managers.get(nameOf(m)) ?? 0) + n);
      else if (m.kind === 'to_office') sentToOffice -= n;
      else if (m.kind === 'to_client') toClients -= n;
      else others += n;
    }
    const received = [...managers.values()].reduce((a, b) => a + b, 0);
    const expected = received + converted - sentToOffice - toClients;
    return {
      currency, fromManagers: [...managers].map(([who, amount]) => ({ who, amount: r2(amount) })).sort((a, b) => b.amount - a.amount),
      received: r2(received), converted: r2(converted), sentToOffice: r2(sentToOffice), toClients: r2(toClients), expected: r2(expected), others: r2(others), balance: r2(expected + others),
    };
  }).sort((a, b) => a.currency.localeCompare(b.currency));
}

// A sum sent to the office and where it went: to clients, to the office's fees, and what
// is not divided yet.
export interface Division { total: number; toClients: number; officeFees: number; other: number; left: number }
export function division(sum: CashMovement, parts: CashMovement[]): Division {
  const mine = parts.filter((p) => p.parent_id === sum.id);
  const of = (k: string) => -mine.filter((p) => p.kind === k).reduce((a, p) => a + Number(p.amount), 0);
  const total = -Number(sum.amount);
  const toClients = of('to_client'), officeFees = of('office_fee');
  const other = -mine.filter((p) => p.kind !== 'to_client' && p.kind !== 'office_fee').reduce((a, p) => a + Number(p.amount), 0);
  return { total: r2(total), toClients: r2(toClients), officeFees: r2(officeFees), other: r2(other), left: r2(total - toClients - officeFees - other) };
}
