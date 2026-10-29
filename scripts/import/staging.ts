// Staging model: what the importer understood from Airtable, before anything
// is written to the database. Mirrors the tables in supabase/migrations.

import { type Corrections, corrections as defaultCorrections } from './corrections.ts';
import { cleanName, nameKey, similarity, tokenSubset } from './lib/parse.ts';

export type Currency = 'ILS' | 'USD' | 'EUR' | 'UAH' | 'RON' | 'GEL';
export type Country = 'UA' | 'RO' | 'GE' | 'GR';
export type Role =
  | 'client' | 'tenant' | 'manager' | 'lawyer' | 'hotel' | 'developer'
  | 'supplier' | 'marketer' | 'internal';

export const MISSING_UNIT = 'ללא מספר';

export interface Party {
  key: string;
  name: string;
  kind: 'person' | 'company';
  roles: Set<Role>;
  emails: Set<string>;
  phones: Set<string>;
  countries: Set<Country>;
  spellings: Set<string>;     // every name it appeared under, kept as external_refs
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
  aliases: string[];          // other Airtable records merged into this one
  externalRefs: { source: string; key: string }[];
  country: Country;
  buildingKey: string;
  unitNo: string;
  floor?: string;
  sqm?: number;
  purchaseDate?: string;
  status: 'under_construction' | 'vacant' | 'rented' | 'short_term' | 'owner_use' | 'sold';
  yomTovLandShare?: boolean;  // Romania "LAND 1% YOM TOV"
  ownerKeys: string[];
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
  start?: string;            // empty in Airtable: imported empty (SPEC decision 35)
  end?: string;
  rent?: number;
  currency?: Currency;
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

type NewProperty = Omit<Property, 'aliases' | 'externalRefs' | 'ownerKeys' | 'unitNo'> & { unitNo?: string };

export class Staging {
  parties = new Map<string, Party>();
  buildings = new Map<string, Building>();
  properties = new Map<string, Property>();
  ownerships: Ownership[] = [];
  leases: Lease[] = [];
  accounts: BankAccount[] = [];
  issues: Issue[] = [];
  counts: Record<string, Record<string, number>> = {};
  readonly fix: Corrections;
  private aliasByKey: Map<string, string>;

  constructor(fix: Corrections = defaultCorrections) {
    this.fix = fix;
    this.aliasByKey = new Map(Object.entries(fix.partyAliases).map(([from, to]) => [nameKey(from), to]));
  }

  issue(country: Issue['country'], severity: Issue['severity'], code: string, message: string) {
    this.issues.push({ country, severity, code, message });
  }

  count(country: string, what: string, n = 1) {
    const m = (this.counts[country] ??= {});
    m[what] = (m[what] ?? 0) + n;
  }

  // Adds or merges a party by name key (after aliases). Returns its key, or undefined for blank names.
  party(rawName: string, country: Country, init: Partial<Omit<Party, 'key' | 'name' | 'spellings'>> & { role?: Role } = {}): string | undefined {
    const spelling = cleanName(rawName);
    const name = this.aliasByKey.get(nameKey(spelling)) ?? spelling;
    const key = nameKey(name);
    if (!key) return undefined;
    let p = this.parties.get(key);
    if (!p) {
      const isCompany = this.fix.companies.includes(name) || /\b(srl|ltd|llc|s\.r\.l|בע"?מ)\b/i.test(name);
      p = {
        key, name, kind: init.kind ?? (isCompany ? 'company' : 'person'),
        roles: new Set(), emails: new Set(), phones: new Set(), countries: new Set(), spellings: new Set(),
      };
      if (this.fix.internal.includes(name)) p.roles.add('internal');
      this.parties.set(key, p);
    }
    p.spellings.add(spelling);
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

  // Apartment number after manual corrections; undefined means "skip this record".
  unitFor(country: Country, sourceId: string, parsed: string | undefined): string | undefined {
    const override = this.fix.unitOverrides[sourceId];
    if (override) return override;
    if (parsed) return parsed;
    if (this.fix.allowMissingUnit.includes(sourceId)) {
      this.issue(country, 'info', 'unit-unknown', `${sourceId}: imported without an apartment number (decided)`);
      return MISSING_UNIT;
    }
    this.issue(country, 'error', 'missing-unit', `${sourceId}: no apartment number`);
    return undefined;
  }

  // Adds a property, or merges it into an existing one when the corrections say
  // they are the same record. Returns the property key, or undefined if rejected.
  addProperty(np: NewProperty & { unitNo: string }, ownerKeys: string[]): string | undefined {
    const key = `${np.country}|${np.buildingKey}|${np.unitNo}`;
    const existing = this.properties.get(key);
    if (existing) {
      const pair = this.fix.mergeProperties.find((m) =>
        [m.keep, m.merge].includes(np.sourceId) && [m.keep, m.merge].includes(existing.sourceId));
      if (!pair) {
        this.issue(np.country, 'error', 'duplicate-property', `${np.sourceId}: same building and apartment as ${existing.sourceId}`);
        return undefined;
      }
      if (pair.keep === np.sourceId) {
        existing.aliases.push(existing.sourceId);
        existing.sourceId = np.sourceId;
      } else {
        existing.aliases.push(np.sourceId);
      }
      existing.ownerKeys.push(...ownerKeys);
      this.issue(np.country, 'info', 'merged', `${pair.merge} merged into ${pair.keep} (decided)`);
      return key;
    }
    const externalRefs = this.fix.externalRefs
      .filter((r) => r.property === np.sourceId)
      .map(({ source, key: k }) => ({ source, key: k }));
    this.properties.set(key, { ...np, key, aliases: [], externalRefs, ownerKeys: [...ownerKeys] });
    return key;
  }

  // Ownership rows with equal shares; Airtable never recorded the split.
  finalizeOwnerships() {
    this.ownerships = [];
    for (const p of this.properties.values()) {
      const owners = [...new Set(p.ownerKeys)];
      if (!owners.length) {
        this.issue(p.country, 'error', 'no-owner', `${p.sourceId}: no owner`);
        continue;
      }
      const share = Math.round((100 / owners.length) * 10000) / 10000;
      for (const partyKey of owners) {
        this.ownerships.push({ propertyKey: p.key, partyKey, sharePct: share, shareAssumed: owners.length > 1 });
      }
      if (owners.length > 1) {
        this.issue(p.country, 'info', 'shares-assumed', `${p.sourceId}: ${owners.length} co-owners, shares set equal (${share}%)`);
      }
    }
  }

  // Names that are probably the same person but did not merge automatically.
  findPossibleDuplicates() {
    const list = [...this.parties.values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (similarity(a.key, b.key) >= 0.8 || tokenSubset(a.key, b.key)) {
          this.issue('ALL', 'warning', 'possible-duplicate',
            `"${a.name}" (${[...a.countries].join(',')}) ↔ "${b.name}" (${[...b.countries].join(',')})`);
        }
      }
    }
  }

  toJSON() {
    const sets = (p: Party) => ({
      ...p, roles: [...p.roles], emails: [...p.emails], phones: [...p.phones],
      countries: [...p.countries], spellings: [...p.spellings],
    });
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
