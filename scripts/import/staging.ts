// Staging model: what the importer understood from Airtable, before anything
// is written to the database. Mirrors the tables in supabase/migrations.

import { cleanName, nameKey, similarity, tokenSubset } from './lib/parse.ts';

export type Currency = 'ILS' | 'USD' | 'EUR' | 'UAH' | 'RON' | 'GEL';
export type Country = 'UA' | 'RO' | 'GE' | 'GR';
export type Role =
  | 'client' | 'tenant' | 'manager' | 'lawyer' | 'hotel' | 'developer'
  | 'supplier' | 'marketer' | 'internal';

export interface Party {
  key: string;
  name: string;
  kind: 'person' | 'company';
  roles: Set<Role>;
  emails: Set<string>;
  phones: Set<string>;
  countries: Set<Country>;
  taxId?: string;
  address?: string;
  referral?: string;
}

export interface Building {
  key: string;
  country: Country;
  city: string;
  project?: string;
  name: string;
  address?: string;
}

export interface Property {
  key: string;
  sourceId: string;           // the Airtable primary field, kept as external_ref
  country: Country;
  buildingKey: string;
  unitNo: string;
  floor?: string;
  sqm?: number;
  purchaseDate?: string;
  status: 'under_construction' | 'vacant' | 'rented' | 'short_term' | 'owner_use' | 'sold';
  yomTovLandShare?: boolean;  // Romania "LAND 1% YOM TOV"
}

export interface Ownership {
  propertyKey: string;
  partyKey: string;
  sharePct: number;
  shareAssumed: boolean;      // Airtable has no shares; split equally
}

export interface Lease {
  propertyKey: string;
  tenantKey?: string;
  start: string;
  end?: string;
  rent: number;
  currency: Currency;
  deposit?: number;
  brokerage?: number;
  collectDay?: number;
  notes?: string;
}

export interface BankAccount {
  ownerKey: string;
  country: Country;
  currency: Currency;
  iban: string;
  bank: string;
}

export interface Issue {
  country: Country | 'ALL';
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

export class Staging {
  parties = new Map<string, Party>();
  buildings = new Map<string, Building>();
  properties = new Map<string, Property>();
  ownerships: Ownership[] = [];
  leases: Lease[] = [];
  accounts: BankAccount[] = [];
  issues: Issue[] = [];
  counts: Record<string, Record<string, number>> = {};

  issue(country: Issue['country'], severity: Issue['severity'], code: string, message: string) {
    this.issues.push({ country, severity, code, message });
  }

  count(country: string, what: string, n = 1) {
    (this.counts[country] ??= {})[what] = ((this.counts[country] ??= {})[what] ?? 0) + n;
  }

  // Adds or merges a party by name key. Returns its key, or undefined for blank names.
  party(rawName: string, country: Country, init: Partial<Omit<Party, 'key' | 'name'>> & { role?: Role } = {}): string | undefined {
    const name = cleanName(rawName);
    const key = nameKey(name);
    if (!key) return undefined;
    let p = this.parties.get(key);
    if (!p) {
      p = {
        key, name, kind: init.kind ?? (/\b(srl|ltd|llc|s\.r\.l|בע"?מ)\b/i.test(name) ? 'company' : 'person'),
        roles: new Set(), emails: new Set(), phones: new Set(), countries: new Set(),
      };
      this.parties.set(key, p);
    }
    p.countries.add(country);
    if (init.role) p.roles.add(init.role);
    for (const e of init.emails ?? []) if (e) p.emails.add(e.toLowerCase());
    for (const ph of init.phones ?? []) if (ph) p.phones.add(ph);
    p.taxId ||= init.taxId;
    p.address ||= init.address;
    p.referral ||= init.referral;
    return key;
  }

  building(b: Omit<Building, 'key'>): string {
    const key = [b.country, b.city, b.project ?? '', b.name].join('|').toLowerCase();
    if (!this.buildings.has(key)) this.buildings.set(key, { key, ...b });
    return key;
  }

  // Equal shares for co-owners; Airtable never recorded the split.
  own(propertyKey: string, partyKeys: string[], country: Country) {
    const unique = [...new Set(partyKeys)];
    if (!unique.length) return;
    const share = Math.round((100 / unique.length) * 10000) / 10000;
    for (const partyKey of unique) {
      this.ownerships.push({ propertyKey, partyKey, sharePct: share, shareAssumed: unique.length > 1 });
    }
    if (unique.length > 1) {
      this.issue(country, 'info', 'shares-assumed',
        `${this.properties.get(propertyKey)?.sourceId}: ${unique.length} co-owners, shares set equal (${share}%)`);
    }
  }

  // Names that are probably the same person but did not merge automatically.
  findPossibleDuplicates() {
    const list = [...this.parties.values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const sim = similarity(a.key, b.key);
        if (sim >= 0.8 || tokenSubset(a.key, b.key)) {
          this.issue('ALL', 'warning', 'possible-duplicate',
            `"${a.name}" (${[...a.countries].join(',')}) ↔ "${b.name}" (${[...b.countries].join(',')})`);
        }
      }
    }
  }

  toJSON() {
    const sets = (p: Party) => ({ ...p, roles: [...p.roles], emails: [...p.emails], phones: [...p.phones], countries: [...p.countries] });
    return {
      parties: [...this.parties.values()].map(sets),
      buildings: [...this.buildings.values()],
      properties: [...this.properties.values()],
      ownerships: this.ownerships,
      leases: this.leases,
      accounts: this.accounts,
      issues: this.issues,
      counts: this.counts,
    };
  }
}
