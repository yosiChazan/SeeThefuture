import { useQuery } from '@tanstack/react-query';
import { must, supabase } from './supabase';
import type { Account, Country, Lease, Property } from './types';

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
  kind: 'person' | 'company';
  email: string | null;
  phone: string | null;
  tax_id: string | null;
  address: string | null;
  notes: string | null;
  referred_by: { id: string; display_name: string } | null;
  ownerships: { valid_to: string | null; property: { id: string; country_code: Country } | null }[];
}

const CLIENT_COLS = `id, display_name, kind, email, phone, tax_id, address, notes,
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

export function useClientProperties(partyId: string) {
  return useQuery({
    queryKey: ['client-properties', partyId],
    queryFn: async () => {
      const ids = must(await supabase.from('ownerships').select('property_id').eq('party_id', partyId)) as { property_id: string }[];
      if (!ids.length) return [] as Property[];
      return must(await supabase.from('properties').select(PROPERTY_COLS).in('id', [...new Set(ids.map((r) => r.property_id))])) as unknown as Property[];
    },
  });
}

const ACCOUNT_COLS = `id, country_code, currency, kind, label, bank_name, iban, card_last4, active,
  holder:parties!accounts_holder_party_id_fkey(id, display_name),
  beneficiary:parties!accounts_beneficiary_party_id_fkey(id, display_name)`;

export function useClientAccounts(partyId: string) {
  return useQuery({
    queryKey: ['client-accounts', partyId],
    queryFn: async () => {
      const accounts = must(await supabase.from('accounts').select(ACCOUNT_COLS).eq('beneficiary_party_id', partyId)) as unknown as Account[];
      const balances = must(await supabase.from('account_balances').select('account_id, balance').eq('beneficiary_party_id', partyId)) as { account_id: string; balance: number }[];
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
  transaction: { occurred_on: string; category: string; description: string | null; status: string };
}

export function useAccountEntries(accountIds: string[]) {
  return useQuery({
    queryKey: ['entries', accountIds],
    enabled: accountIds.length > 0,
    queryFn: async () => must(await supabase.from('entries')
      .select('id, amount, currency, memo, account_id, transaction:transactions(occurred_on, category, description, status)')
      .in('account_id', accountIds).limit(200)) as unknown as EntryRow[],
  });
}
