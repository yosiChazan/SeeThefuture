// Romania base: Persons, PROPERTIES, Lease Agreement, Accounts.
// The Owners field mixes owners and tenants, so Persons.TYPE decides who is an owner.

import { join } from 'node:path';
import { readCsv } from '../lib/csv.ts';
import { cleanName, nameKey, parseAmount, parseDate, splitNames } from '../lib/parse.ts';
import type { Currency, Role, Staging } from '../staging.ts';

const ACCOUNT_CURRENCY: Record<string, Currency> = { RON: 'RON', EURO: 'EUR', USD: 'USD' };

// "Alexandru Beldiman 1, 3rd floor, Apt 31- (BIG)" → street, floor, unit.
// Split apartments keep their part in the unit: 31-BIG, 32-LOT1-BIG, 6-1.
export function parseRomanianAddress(address: string) {
  const street = cleanName(address.split(',')[0].replace(/\bApt\b.*$/i, '').replace(/_.*$/, ''));
  const floor = address.match(/(\d+)\s*(?:st|nd|rd|th)\s+floor/i)?.[1];
  const apt = address.match(/\bapt\.?\s*([0-9]+[A-Za-z]?)/i)?.[1]
    ?? address.match(/,\s*([0-9]+[A-Za-z]?)\s*-\s*LOT/i)?.[1];
  const parts = [
    address.match(/\bLOT\s*(\d+)/i)?.[1] && `LOT${address.match(/\bLOT\s*(\d+)/i)![1]}`,
    address.match(/\((BIG|SMALL|\d)\)|-\s*(Big|Small)\b/i)?.slice(1).find(Boolean)?.toUpperCase(),
  ].filter(Boolean);
  return { street, floor, unitNo: apt ? [apt, ...parts].join('-') : undefined };
}

export function importRomania(dir: string, s: Staging) {
  const C = 'RO';
  const typeByKey = new Map<string, string>();

  for (const r of readCsv(join(dir, 'Persons-All Person.csv'))) {
    if (!r.Name) continue;
    const role: Role | undefined = r.TYPE === 'OWNER' ? 'client' : r.TYPE === 'TENT' ? 'tenant'
      : r.TYPE === 'SUPPLIER' ? 'supplier' : undefined;
    typeByKey.set(nameKey(r.Name), r.TYPE);
    s.party(r.Name, C, { role, emails: [r.Email], phones: [r['Phone number']] });
    s.count(C, 'persons');
  }
  const yomTov = s.party('YOM TOV SRL', C, { role: 'internal', kind: 'company' })!;

  const byName = new Map<string, string>();
  for (const r of readCsv(join(dir, 'PROPERTIES-TEMP.csv'))) {
    const sourceId = cleanName(r.ID);
    if (!cleanName(r.Address)) continue;
    s.count(C, 'properties (rows)');
    const { street, floor, unitNo: parsedUnit } = parseRomanianAddress(r.Address);
    const unitNo = s.unitFor(C, sourceId, parsedUnit);
    if (!unitNo) continue;
    const buildingName = cleanName(r.Building) || street;
    const buildingKey = s.building({ country: C, city: 'Bucharest', name: buildingName, address: street });

    const owners: string[] = [];
    for (const n of splitNames(r.Owners)) {
      const type = typeByKey.get(nameKey(n));
      const looksLikeOwner = type === 'OWNER' || (!type && n === n.toUpperCase()) || /yom tov/i.test(n);
      if (type === 'TENT' || !looksLikeOwner) {
        s.issue(C, 'info', 'tenant-in-owners', `${sourceId}: "${n}" listed under Owners but is a tenant; not imported as owner`);
        continue;
      }
      owners.push(/yom tov/i.test(n) ? yomTov : s.party(n, C, { role: 'client' })!);
    }
    const key = s.addProperty({
      sourceId, country: C, buildingKey, unitNo, floor,
      sqm: parseAmount(r.SQM), purchaseDate: parseDate(r['Purchase Date']),
      status: 'vacant', yomTovLandShare: !!r['LAND 1% YOM TOV'],
    }, owners);
    if (!key) continue;
    byName.set(sourceId, key);
    s.count(C, 'properties');
  }

  for (const r of readCsv(join(dir, 'Lease Agreement-all.csv'))) {
    s.count(C, 'leases (rows)');
    // A lease can link several records ("3 - ... Apt 6 (1) ...,55 - ... Apt 6 (2) ...")
    // when one tenant rents both halves of a split apartment.
    const linked = r.Property.split(/,(?=\s*"?\d+ - )/).map(cleanName).filter(Boolean);
    const matched = linked.map((n) => byName.get(n)).filter((k): k is string => !!k);
    const propertyKey = matched[0];
    const start = parseDate(r['Start Date']);
    const rent = parseAmount(r['Monthly Price - Euro']);
    const label = `${linked[0] ?? '(no property)'} ${r['Start Date']}`;
    if (!propertyKey) { s.issue(C, 'warning', 'lease-unmatched', `${label}: property not found`); continue; }
    if (!start || rent === undefined) { s.issue(C, 'warning', 'lease-incomplete', `${label}: missing start or monthly price`); continue; }
    if (matched.length > 1) {
      s.issue(C, 'info', 'lease-multi-unit', `${label}: one lease for ${matched.length} units; attached to the first`);
    }
    const [tenant, ...coTenants] = splitNames(r['Tenant Name'] || r['Apt Tenant']);
    s.leases.push({
      propertyKey, start, end: parseDate(r['End date']), rent, currency: 'EUR',
      tenantKey: tenant ? s.party(tenant, C, { role: 'tenant' }) : undefined,
      deposit: parseAmount(r['Guaranty -Euro']), collectDay: parseInt(r['Collect Day'], 10) || undefined,
      notes: [coTenants.length ? `Also tenant: ${coTenants.join(', ')}` : '', r.Notes].filter(Boolean).join('\n') || undefined,
    });
    if (r['האם נמכרה']) s.properties.get(propertyKey)!.status = 'sold';
    s.count(C, 'leases');
  }

  for (const r of readCsv(join(dir, 'Accounts-Grid view.csv'))) {
    const iban = r['Account NO'].replace(/\s/g, '');
    const currency = ACCOUNT_CURRENCY[r.Type];
    if (!iban || !currency || !r.Owners) continue;
    const ownerKey = s.party(splitNames(r.Owners)[0], C, { role: 'client' })!;
    s.accounts.push({ ownerKey, country: C, currency, iban, bank: iban.includes('BREL') ? 'Libra Internet Bank' : 'unknown' });
    s.count(C, 'bank accounts');
  }

  const landShare = [...s.properties.values()].filter((p) => p.country === C && p.yomTovLandShare).length;
  s.issue(C, 'warning', 'yomtov-share',
    `${landShare} properties are marked "LAND 1% YOM TOV". Imported with the client at 100% until we decide whether Yom-Tov's 1% shares in rent (SPEC §11 #1)`);
}
