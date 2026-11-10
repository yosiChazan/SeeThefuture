import { useQuery } from '@tanstack/react-query';
import { must, supabase } from './supabase';
import type { Account, Country, Currency, Lease, Property } from './types';
import type { PurchasePayment } from './purchase';

const LEASE_COLS = `id, property_id, start_date, end_date, rent_amount, rent_currency, deposit_amount, deposit_currency,
  brokerage_fee, brokerage_currency, collect_day, withholding_tax_pct, notes, tenant:parties(id, display_name)`;

const PROPERTY_COLS = `id, unit_no, floor, sqm, status, country_code, notes,
  building:buildings(id, name, address, city:cities(name_he, name_en), project:projects(name)),
  ownerships(id, share_pct, valid_from, valid_to, notes, party:parties(id, display_name)),
  leases(${LEASE_COLS})`;

// The office works with a few hundred properties, so lists load everything
// once and filter in the browser.
export function useProperties() {
  return useQuery({
    queryKey: ['properties'],
    queryFn: async () => must(await supabase.from('properties').select(PROPERTY_COLS)) as unknown as Property[],
  });
}

export function useProperty(id: string) {
  return useQuery({
    queryKey: ['property', id],
    queryFn: async () => must(await supabase.from('properties').select(PROPERTY_COLS).eq('id', id).single()) as unknown as Property,
  });
}

export interface LeaseRow extends Lease {
  property: Pick<Property, 'id' | 'unit_no' | 'country_code' | 'status'> & { building: { name: string; city: { name_he: string }; project: { name: string } | null } };
}

export function useLeases() {
  return useQuery({
    queryKey: ['leases'],
    queryFn: async () => must(await supabase.from('leases').select(
      `${LEASE_COLS}, property:properties(id, unit_no, country_code, status, building:buildings(name, city:cities(name_he), project:projects(name)))`,
    )) as unknown as LeaseRow[],
  });
}

export interface ClientRow {
  id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  // One row or none (party_identity is keyed by the party); PostgREST may send either shape.
  identity: { id_number: string } | { id_number: string }[] | null;
  legal_name: string | null;
  kind: 'person' | 'company';
  email: string | null;
  phone: string | null;
  tax_id: string | null;
  address: string | null;
  notes: string | null;
  referred_by: { id: string; display_name: string } | null;
  party_roles?: { role: string }[];
  ownerships: { valid_to: string | null; property: { id: string; country_code: Country } | null }[];
}

const CLIENT_COLS = `id, display_name, first_name, last_name, legal_name, kind, email, phone, tax_id, address, notes,
  identity:party_identity(id_number),
  referred_by:parties!referred_by_party_id(id, display_name),
  ownerships(valid_to, property:properties(id, country_code)), party_roles!inner(role)`;

export function useClients() {
  return useQuery({
    queryKey: ['clients'],
    queryFn: async () => must(await supabase.from('parties').select(CLIENT_COLS).eq('party_roles.role', 'client')) as unknown as ClientRow[],
  });
}

export function useClient(id: string) {
  return useQuery({
    queryKey: ['client', id],
    queryFn: async () => must(await supabase.from('parties').select(CLIENT_COLS.replace('party_roles!inner(role)', 'party_roles(role)')).eq('id', id).single()) as unknown as ClientRow,
  });
}

export function useClientProperties(partyIds: string | string[]) {
  const party = ([] as string[]).concat(partyIds);
  return useQuery({
    queryKey: ['client-properties', party],
    queryFn: async () => {
      const ids = must(await supabase.from('ownerships').select('property_id').in('party_id', party)) as { property_id: string }[];
      if (!ids.length) return [] as Property[];
      return must(await supabase.from('properties').select(PROPERTY_COLS).in('id', [...new Set(ids.map((r) => r.property_id))])) as unknown as Property[];
    },
  });
}

const ACCOUNT_COLS = `id, country_code, currency, kind, label, bank_name, iban, card_last4, active,
  holder:parties!accounts_holder_party_id_fkey(id, display_name),
  beneficiary:parties!accounts_beneficiary_party_id_fkey(id, display_name)`;

export function useClientAccounts(partyIds: string | string[]) {
  const party = ([] as string[]).concat(partyIds);
  return useQuery({
    queryKey: ['client-accounts', party],
    queryFn: async () => {
      const accounts = must(await supabase.from('accounts').select(ACCOUNT_COLS).in('beneficiary_party_id', party)) as unknown as Account[];
      const balances = must(await supabase.from('account_balances').select('account_id, balance').in('beneficiary_party_id', party)) as { account_id: string; balance: number }[];
      const byId = new Map(balances.map((b) => [b.account_id, Number(b.balance)]));
      return accounts.map((a) => ({ ...a, balance: byId.get(a.id) ?? 0 }));
    },
  });
}

export interface EntryRow {
  id: string;
  amount: number;
  currency: string;
  memo: string | null;
  account_id: string | null;
  transaction: { id: string; occurred_on: string; period?: string; category: string; description: string | null; status: string; import_batch_id?: string | null; created_by?: string | null; country_code?: string; source?: string | null };
}

// Every posted entry of the accounts, oldest first. The API returns at most 1,000
// rows per request, so it is read in pages.
export function useAccountEntries(accountIds: string[]) {
  return useQuery({
    queryKey: ['entries', accountIds],
    enabled: accountIds.length > 0,
    queryFn: async () => {
      const out: EntryRow[] = [];
      for (let from = 0; ; from += 1000) {
        const page = must(await supabase.from('entries')
          .select('id, amount, currency, memo, account_id, transaction:transactions!inner(id, occurred_on, period, category, description, status, import_batch_id, created_by, country_code)')
          .in('account_id', accountIds).eq('transaction.status', 'posted').order('id').range(from, from + 999)) as unknown as EntryRow[];
        out.push(...page);
        if (page.length < 1000) break;
      }
      return out.sort((a, b) => a.transaction.occurred_on.localeCompare(b.transaction.occurred_on) || a.transaction.id.localeCompare(b.transaction.id));
    },
  });
}

// A property's posted entries with their accounts, oldest first, in pages of 1,000.
export function usePropertyEntries(propertyId: string) {
  return useQuery({
    queryKey: ['property-entries', propertyId],
    queryFn: async () => {
      const out: (EntryRow & { account: Account })[] = [];
      for (let from = 0; ; from += 1000) {
        const page = must(await supabase.from('entries')
          .select(`id, amount, currency, memo, account_id, transaction:transactions!inner(id, occurred_on, period, category, description, status, import_batch_id, created_by, country_code), account:accounts!inner(${ACCOUNT_COLS})`)
          .eq('property_id', propertyId).eq('transaction.status', 'posted').order('id').range(from, from + 999)) as unknown as (EntryRow & { account: Account })[];
        out.push(...page);
        if (page.length < 1000) break;
      }
      out.sort((a, b) => a.transaction.occurred_on.localeCompare(b.transaction.occurred_on) || a.transaction.id.localeCompare(b.transaction.id));
      const accounts = [...new Map(out.map((e) => [e.account.id, e.account])).values()];
      return { entries: out as EntryRow[], accounts };
    },
  });
}

// A client's ID number; every staff member sees it (SPEC decision 72).
export interface Identity { party_id: string; id_number: string; source: string | null; updated_at: string }
export const idNumberOf = (c: Pick<ClientRow, 'identity'>) => (Array.isArray(c.identity) ? c.identity[0]?.id_number : c.identity?.id_number) ?? null;

export function useIdentity(partyId: string, enabled = true) {
  return useQuery({
    queryKey: ['identity', partyId],
    enabled,
    queryFn: async () => must(await supabase.from('party_identity').select('party_id, id_number, source, updated_at').eq('party_id', partyId).maybeSingle()) as Identity | null,
  });
}

export async function saveIdentity(partyId: string, idNumber: string | null, source: string) {
  if (!idNumber) return must(await supabase.from('party_identity').delete().eq('party_id', partyId));
  return must(await supabase.from('party_identity').upsert({ party_id: partyId, id_number: idNumber, source, updated_at: new Date().toISOString() }));
}

// One lease with its property, owners and tenant, for the lease card (SPEC decision 68).
export interface LeaseCardRow extends Lease {
  payment_currency: Currency | null;
  property: Pick<Property, 'id' | 'unit_no' | 'country_code' | 'status'> & {
    building: { name: string; address: string | null; city: { name_he: string }; project: { name: string } | null };
    ownerships: { share_pct: number; valid_from: string; valid_to: string | null; party: { id: string; display_name: string } }[];
  };
}
export function useLease(id: string) {
  return useQuery({
    queryKey: ['lease', id],
    queryFn: async () => must(await supabase.from('leases').select(
      `${LEASE_COLS}, payment_currency, property:properties(id, unit_no, country_code, status,
        building:buildings(name, address, city:cities(name_he), project:projects(name)),
        ownerships(share_pct, valid_from, valid_to, party:parties(id, display_name)))`,
    ).eq('id', id).single()) as unknown as LeaseCardRow,
  });
}

// The purchase of a property, with its payments (SPEC decision 70).
export interface DealRow {
  id: string; signed_on: string | null; status: 'lead' | 'in_progress' | 'completed' | 'cancelled';
  total_price: number | null; price_currency: Currency | null; notes: string | null;
  client: { id: string; display_name: string } | null; referrer: { id: string; display_name: string } | null;
  installments: { id: string; due_date: string | null; amount: number; currency: Currency; notes: string | null; paid_txn_id: string | null }[];
}
export function usePropertyDeals(propertyId: string) {
  return useQuery({
    queryKey: ['deals', propertyId],
    queryFn: async () => must(await supabase.from('deals').select(`id, signed_on, status, total_price, price_currency, notes,
      client:parties!deals_client_party_id_fkey(id, display_name), referrer:parties!deals_referrer_party_id_fkey(id, display_name),
      installments(id, due_date, amount, currency, notes, paid_txn_id)`).eq('property_id', propertyId).order('signed_on')) as unknown as DealRow[],
  });
}

// Money paid around a purchase: toward the price, fees, costs, the client's transfers (SPEC decisions 83, 84).
export interface PurchasePaymentRow extends PurchasePayment {
  property_id: string; payer_name: string | null; payee_name: string | null;
  payer: { id: string; display_name: string } | null; payee: { id: string; display_name: string } | null;
}
const PURCHASE_PAYMENT_COLUMNS = `id, property_id, paid_on, kind, amount, currency, amount_usd, payer_name, payee_name, notes,
  payer:parties!purchase_payments_payer_party_id_fkey(id, display_name), payee:parties!purchase_payments_payee_party_id_fkey(id, display_name)`;
export function usePurchasePayments(propertyId: string) {
  return useQuery({
    queryKey: ['purchase_payments', propertyId],
    queryFn: async () => must(await supabase.from('purchase_payments').select(PURCHASE_PAYMENT_COLUMNS)
      .eq('property_id', propertyId).order('paid_on', { nullsFirst: true })) as unknown as PurchasePaymentRow[],
  });
}

// A property's services and its charges history (SPEC decision 71).
export interface ServiceRow { id: string; kind: string; provider: string | null; client_code: string | null; status: string | null; deadline: string | null; notes: string | null }
export interface ChargeRow { id: string; period: string; kind: string; amount: number; currency: Currency; due_date: string | null; payer: string; status: string; notes: string | null; document_id?: string | null }
export function usePropertyServices(propertyId: string) {
  return useQuery({
    queryKey: ['services', propertyId],
    queryFn: async () => must(await supabase.from('utility_contracts').select('id, kind, provider, client_code, status, deadline, notes').eq('property_id', propertyId)) as ServiceRow[],
  });
}
export function usePropertyCharges(propertyId: string) {
  return useQuery({
    queryKey: ['charges', propertyId],
    queryFn: async () => {
      const out: ChargeRow[] = [];
      for (let from = 0; ; from += 1000) {
        const page = must(await supabase.from('charges').select('id, period, kind, amount, currency, due_date, payer, status, notes, document_id')
          .eq('property_id', propertyId).order('period', { ascending: false }).order('kind').range(from, from + 999)) as ChargeRow[];
        out.push(...page);
        if (page.length < 1000) return out;
      }
    },
  });
}

// The charges and purchases of the properties a client owns, each within the client's
// ownership period (SPEC decision 74). Display only: the ledger is unchanged.
export function useClientPropertyActivity(partyIds: string | string[]) {
  const party = ([] as string[]).concat(partyIds);
  return useQuery({
    queryKey: ['client-activity', party],
    queryFn: async () => {
      const owned = must(await supabase.from('ownerships').select('property_id, share_pct, valid_from, valid_to').in('party_id', party)) as
        { property_id: string; share_pct: number; valid_from: string; valid_to: string | null }[];
      const ids = [...new Set(owned.map((o) => o.property_id))];
      if (!ids.length) return { charges: [] as (ChargeRow & { property_id: string })[], deals: [] as (DealRow & { property_id: string })[], payments: [] as PurchasePaymentRow[], owned };
      const charges: (ChargeRow & { property_id: string })[] = [];
      for (let from = 0; ; from += 1000) {
        const page = must(await supabase.from('charges').select('id, property_id, period, kind, amount, currency, due_date, payer, status, notes, document_id')
          .in('property_id', ids).order('period', { ascending: false }).order('kind').range(from, from + 999)) as (ChargeRow & { property_id: string })[];
        charges.push(...page);
        if (page.length < 1000) break;
      }
      const deals = must(await supabase.from('deals').select(`id, property_id, signed_on, status, total_price, price_currency, notes,
        client:parties!deals_client_party_id_fkey(id, display_name), referrer:parties!deals_referrer_party_id_fkey(id, display_name),
        installments(id, due_date, amount, currency, notes, paid_txn_id)`).in('property_id', ids)) as unknown as (DealRow & { property_id: string })[];
      const payments = must(await supabase.from('purchase_payments').select(PURCHASE_PAYMENT_COLUMNS)
        .in('property_id', ids).order('paid_on', { nullsFirst: true })) as unknown as PurchasePaymentRow[];
      // A charge belongs to the owner of that month.
      const ownedOn = (pid: string, period: string) => owned.some((o) => o.property_id === pid && o.valid_from.slice(0, 7) <= period.slice(0, 7) && (!o.valid_to || o.valid_to >= period));
      return { charges: charges.filter((c) => ownedOn(c.property_id, c.period)), deals, payments, owned };
    },
  });
}

// Everyone who is not a client: tenants, suppliers, lawyers, managers, marketers and
// parties set aside as contacts (SPEC decision 76).
export interface ContactRow {
  id: string; display_name: string; kind: 'person' | 'company'; phone: string | null; email: string | null; notes: string | null;
  party_roles: { role: string }[];
}
export function useContacts() {
  return useQuery({
    queryKey: ['contacts'],
    queryFn: async () => {
      const rows = must(await supabase.from('parties').select('id, display_name, kind, phone, email, notes, party_roles(role)').order('display_name')) as ContactRow[];
      return rows.filter((p) => !p.party_roles.some((r) => r.role === 'client'));
    },
  });
}

export async function setClientRole(partyId: string, asClient: boolean) {
  must(await supabase.from('party_roles').delete().eq('party_id', partyId).eq('role', asClient ? 'contact' : 'client'));
  must(await supabase.from('party_roles').upsert({ party_id: partyId, role: asClient ? 'client' : 'contact' }, { onConflict: 'party_id,role', ignoreDuplicates: true }));
}

// Partners shown as one client (SPEC decision 77): the member's card points to the main
// client, and the main client's card shows the member's properties and accounts too.
export interface PartyLink { member_party_id: string; main_party_id: string; relation: 'spouse' | 'partner' | 'authorized'; member: { id: string; display_name: string; phone: string | null; email: string | null }; main: { id: string; display_name: string } }
export function usePartyLinks() {
  return useQuery({
    queryKey: ['party-links'],
    queryFn: async () => must(await supabase.from('party_links').select(`member_party_id, main_party_id, relation,
      member:parties!party_links_member_party_id_fkey(id, display_name, phone, email), main:parties!party_links_main_party_id_fkey(id, display_name)`)) as unknown as PartyLink[],
  });
}
export const RELATION_HE: Record<PartyLink['relation'], string> = { spouse: 'בן/בת זוג', partner: 'שותף', authorized: 'מורשה' };
