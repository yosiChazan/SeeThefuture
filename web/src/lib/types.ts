export type Country = 'UA' | 'RO' | 'GE' | 'GR';
export type Currency = 'ILS' | 'USD' | 'EUR' | 'UAH' | 'RON' | 'GEL';
export type PropertyStatus = 'under_construction' | 'vacant' | 'rented' | 'short_term' | 'owner_use' | 'sold';

export interface PartyRef { id: string; display_name: string }

export interface Lease {
  id: string;
  property_id: string;
  start_date: string | null;
  end_date: string | null;
  rent_amount: number | null;
  rent_currency: Currency | null;
  deposit_amount: number | null;
  deposit_currency: Currency | null;
  brokerage_fee: number | null;
  brokerage_currency: Currency | null;
  collect_day: number | null;
  withholding_tax_pct: number;
  notes: string | null;
  tenant: PartyRef | null;
}

export interface Ownership {
  id: string;
  share_pct: number;
  valid_from: string;
  valid_to: string | null;
  notes: string | null;
  party: PartyRef;
}

export interface Building {
  id: string;
  name: string;
  address: string | null;
  city: { name_he: string; name_en: string };
  project: { name: string } | null;
}

export interface Property {
  id: string;
  unit_no: string;
  floor: string | null;
  sqm: number | null;
  status: PropertyStatus;
  country_code: Country;
  notes: string | null;
  building: Building;
  ownerships: Ownership[];
  leases: Lease[];
}

export interface Account {
  id: string;
  country_code: Country;
  currency: Currency;
  kind: string;
  label: string | null;
  bank_name: string | null;
  iban: string | null;
  card_last4: string | null;
  active: boolean;
  holder: PartyRef;
  beneficiary: PartyRef;
}
