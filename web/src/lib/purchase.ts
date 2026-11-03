import type { Currency } from './types';

// One row of app.purchase_payments (SPEC decisions 83, 84).
export type PurchaseKind = 'payment' | 'fee' | 'expense' | 'income' | 'loan' | 'transfer';
export interface PurchasePayment {
  id: string; paid_on: string | null; kind: PurchaseKind; amount: number | null; currency: Currency | null;
  amount_usd: number | null; notes: string | null;
}
export interface Planned { amount: number; currency: Currency; paid_txn_id: string | null }

export const KIND_HE: Record<PurchaseKind, string> = {
  payment: 'תשלום על הדירה', fee: 'עמלה', expense: 'הוצאה', income: 'הכנסה', loan: 'הלוואה', transfer: 'העברה של הלקוח',
};

export interface PurchaseSummary {
  /** Paid toward the price, in the price's currency; null when nothing is marked as such. */
  paid: number | null;
  /** Payments toward the price in another currency with no stated value in the price's currency. */
  unvalued: Partial<Record<Currency, number>>;
  remaining: number | null;
  /** Fees and other costs, by currency (a stated dollar value is used when the price is in dollars). */
  costs: Partial<Record<Currency, number>>;
  /** Planned payments not paid yet, by currency. */
  planned: Partial<Record<Currency, number>>;
}

// Price, paid and remaining. Nothing is converted: a payment counts in the price's currency
// only when it was made in it, or when the source stated its dollar value (amount_usd).
export function purchaseSummary(price: number | null, currency: Currency | null, payments: PurchasePayment[], installments: Planned[]): PurchaseSummary {
  const cur = currency ?? 'USD';
  const add = (m: Partial<Record<Currency, number>>, c: Currency, n: number) => { m[c] = round((m[c] ?? 0) + n); };
  const valueIn = (p: PurchasePayment): number | null => {
    if (p.amount === null) return null;
    if (p.currency === cur) return Number(p.amount);
    if (cur === 'USD' && p.amount_usd !== null) return Number(p.amount_usd);
    return null;
  };
  let paid: number | null = null;
  const unvalued: PurchaseSummary['unvalued'] = {}, costs: PurchaseSummary['costs'] = {}, planned: PurchaseSummary['planned'] = {};
  for (const p of payments) {
    if (p.amount === null || !p.currency) continue;
    const v = valueIn(p);
    if (p.kind === 'payment') {
      if (v === null) add(unvalued, p.currency, Number(p.amount));
      else paid = round((paid ?? 0) + v);
    } else if (p.kind === 'fee' || p.kind === 'expense') {
      if (v === null) add(costs, p.currency, Number(p.amount)); else add(costs, cur, v);
    }
  }
  for (const i of installments) if (!i.paid_txn_id) add(planned, i.currency, Number(i.amount));
  const remaining = price !== null && paid !== null ? round(Number(price) - paid) : null;
  return { paid, unvalued, remaining, costs, planned };
}

const round = (n: number) => Math.round(n * 100) / 100;
