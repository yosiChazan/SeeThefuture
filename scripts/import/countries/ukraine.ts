// Ukraine base: Person, Building, Property, Lease Agreament.

import { join } from 'node:path';
import { readCsv } from '../lib/csv.ts';
import { cleanName, parseAmount, parseCurrency, parseDate, splitNames } from '../lib/parse.ts';
import type { Role, Staging } from '../staging.ts';

const AREAS: Record<string, { city: string; project?: string }> = {
  'קייב': { city: 'Kyiv' },
  'ארקדיה-אודסה': { city: 'Odessa', project: 'Arcadia' },
  'מרכז העיר אודסה': { city: 'Odessa', project: 'City center' },
};

const REFERRALS: Record<string, string> = { 'דרך חני': 'Shtiglitz Chana' };

export function importUkraine(dir: string, s: Staging) {
  const C = 'UA';

  for (const r of readCsv(join(dir, 'Person-Grid view.csv'))) {
    if (!r.Name || /\.(pdf|jpe?g|png)$/i.test(r.Name)) continue;
    const role: Role = r.TYPE === 'SUPPLIER' ? 'supplier' : /עו"?ד/.test(r.Name) ? 'lawyer' : 'client';
    s.party(r.Name, C, {
      role, emails: [r.email], phones: [r['Phone number']], address: r.Address,
      taxId: r['VAT NUMBER'], referral: REFERRALS[r['גורם מפנה']] ?? (r['גורם מפנה'] || undefined),
    });
    s.count(C, 'persons');
  }

  const buildingProject = new Map<string, string>();
  for (const r of readCsv(join(dir, 'Building-Grid view.csv'))) {
    const id = cleanName(r.Id);
    if (!id) continue;
    const project = cleanName(r.Project) || (/טובול/.test(id) ? 'Tobol' : '');
    buildingProject.set(id, project);
  }

  const byName = new Map<string, string>();
  for (const r of readCsv(join(dir, 'Property-Grid view.csv'))) {
    const sourceId = cleanName(r.Name);
    if (!sourceId || sourceId === '--') continue;
    s.count(C, 'properties (rows)');
    const area = AREAS[cleanName(r.Area)];
    if (!area) {
      s.issue(C, 'error', 'unknown-area', `${sourceId}: Area "${r.Area}" is not Kyiv / Arcadia / Odessa center`);
      continue;
    }
    const unitNo = s.unitFor(C, sourceId, cleanName(r['Apartment number']) || undefined);
    if (!unitNo) continue;

    // Kyiv rows name a building ("2.4 Lake city"); Odessa rows only have an address.
    const buildingId = cleanName(r.Building);
    let buildingName: string, project = area.project;
    if (buildingId) {
      project = buildingProject.get(buildingId) || undefined;
      buildingName = project ? buildingId.replace(project, '').trim() || buildingId : buildingId;
    } else if (area.project === 'Arcadia') {
      buildingName = 'Arcadia';
    } else if (cleanName(r.address)) {
      buildingName = cleanName(r.address);
    } else {
      buildingName = '(unknown)';
      s.issue(C, 'warning', 'missing-building', `${sourceId}: no building or address`);
    }
    const buildingKey = s.building({ country: C, city: area.city, project, name: buildingName, address: cleanName(r.address) || undefined });

    const owners = splitNames(r.Owner).map((n) => s.party(n, C, { role: 'client' })).filter((k): k is string => !!k);
    const key = s.addProperty({
      sourceId, country: C, buildingKey, unitNo,
      floor: cleanName(r.floor) || undefined, sqm: parseAmount(r.Sqm),
      purchaseDate: parseDate(r['Purchase date']), status: 'vacant',
    }, owners);
    if (!key) continue;
    byName.set(sourceId, key);
    s.count(C, 'properties');
  }

  for (const r of readCsv(join(dir, 'Lease Agreament-all contract.csv'))) {
    s.count(C, 'leases (rows)');
    const propertyKey = byName.get(cleanName(r.Property));
    const start = parseDate(r['Start date']);
    const rent = parseAmount(r.Amount);
    const currency = parseCurrency(r.Currency);
    const label = `${cleanName(r.Property)} ${r['Start date']}`;
    if (!propertyKey) { s.issue(C, 'warning', 'lease-unmatched', `${label}: property not found`); continue; }
    if (!start || rent === undefined || !currency) { s.issue(C, 'warning', 'lease-incomplete', `${label}: missing start, amount or currency`); continue; }
    if (r.Status !== 'מושכר' && /לא מושכר/.test(r.Name)) { s.count(C, 'vacancy periods (skipped)'); continue; }
    if (rent > 1_000_000) s.issue(C, 'warning', 'lease-amount', `${label}: amount ${r.Amount} looks like two numbers joined`);
    s.leases.push({
      propertyKey, start, end: parseDate(r['End date']), rent, currency,
      deposit: parseAmount(r.Guaranty), brokerage: parseAmount(r['Brokerage fee']),
      collectDay: parseInt(r['Collect date'], 10) || undefined, notes: r.Notes || undefined,
    });
    s.count(C, 'leases');
  }
}
