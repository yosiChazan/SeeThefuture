// Georgia base: person, Property, lease agreament.

import { join } from 'node:path';
import { readCsv } from '../lib/csv.ts';
import { cleanName, parseAmount, parseDate, splitNames } from '../lib/parse.ts';
import type { Role, Staging } from '../staging.ts';

// The BUILDING field is really the project; each project is one building.
const PROJECTS: Record<string, { city: string; status: 'short_term' | 'under_construction' | 'vacant' }> = {
  'Alliance - Meroit Card yard': { city: 'Batumi', status: 'short_term' },
  'Marina club': { city: 'Batumi', status: 'short_term' },
  'Holiday Inn': { city: 'Batumi', status: 'short_term' },
  'Panorama': { city: 'Batumi', status: 'under_construction' },
  'Tbilisi': { city: 'Tbilisi', status: 'vacant' },
};

const JUNK_NAMES = /^(טרם שולם|-)$/;

export function importGeorgia(dir: string, s: Staging) {
  const C = 'GE';

  for (const r of readCsv(join(dir, 'person-Grid view.csv'))) {
    if (!r.Name || JUNK_NAMES.test(cleanName(r.Name))) continue;
    const type = r.TYPE.toLowerCase();
    const role: Role = type === 'owner' ? 'client' : type === 'supplier' ? 'supplier'
      : /עו"?ד|נוטריון/.test(r.Name) ? 'lawyer' : 'client';
    s.party(r.Name, C, { role, emails: [r.Email], phones: [r['Phone number']], address: r['home address'] });
    s.count(C, 'persons');
  }

  const byName = new Map<string, string>();
  for (const r of readCsv(join(dir, 'Property-Grid view.csv'))) {
    const sourceId = cleanName(r.ID);
    const projectName = cleanName(r.BUILDING);
    if (!cleanName(r.OWNER)) {
      if (projectName) s.issue(C, 'info', 'empty-row', `"${sourceId}": no owner, skipped`);
      continue;
    }
    s.count(C, 'properties (rows)');
    const project = PROJECTS[projectName];
    if (!project) { s.issue(C, 'error', 'unknown-project', `${sourceId}: project "${projectName}" unknown`); continue; }
    // Hotel units are numbered floor + two-digit apartment (floor 14, apt 4 → 1404),
    // as in the land registry extracts and hotel statements. Panorama and Tbilisi
    // already carry the full number.
    const apt = cleanName(r['מספר דירה']).replace(/^0+(?=\d)/, '');
    const floorNo = cleanName(r['קומה']).replace(/^0+(?=\d)/, '');
    const hotelNumbering = project.status === 'short_term' && /^\d{1,2}$/.test(apt) && /^\d+$/.test(floorNo);
    const unitNo = s.unitFor(C, sourceId, hotelNumbering ? `${floorNo}${apt.padStart(2, '0')}` : apt || undefined);
    if (!unitNo) continue;

    const address = cleanName(r['כתובת']);
    const buildingKey = s.building({
      country: C, city: project.city, project: projectName,
      name: projectName === 'Tbilisi' ? (address || 'Tbilisi') : projectName,
      address: /^https?:/.test(address) ? undefined : address || undefined,
    });
    if (/טרם נקנ/.test(r.Notes)) s.issue(C, 'warning', 'not-purchased', `${sourceId}: notes say "not purchased yet"`);
    const owners = splitNames(r.OWNER).map((n) => s.party(n, C, { role: 'client' })).filter((k): k is string => !!k);
    const key = s.addProperty({
      sourceId, country: C, buildingKey, unitNo,
      floor: floorNo || undefined,
      sqm: parseAmount(r['גודל מ"ר']), purchaseDate: parseDate(r['תאריך רכישה (ראשוני)']),
      status: project.status,
    }, owners);
    if (!key) continue;
    byName.set(sourceId, key);
    s.count(C, 'properties');
  }

  for (const r of readCsv(join(dir, 'lease agreament-all.csv'))) {
    s.count(C, 'leases (rows)');
    const label = `${cleanName(r.Property)} ${r['start date']}`;
    if (r.Status !== 'מושכר') { s.count(C, 'vacancy periods (skipped)'); continue; }
    const propertyKey = byName.get(cleanName(r.Property));
    const start = parseDate(r['start date']);
    const rent = parseAmount(r['סכום חודשי']);
    if (!propertyKey) { s.issue(C, 'warning', 'lease-unmatched', `${label}: property not found`); continue; }
    if (!start || rent === undefined) { s.issue(C, 'warning', 'lease-incomplete', `${label}: missing start or amount`); continue; }
    const tenant = cleanName(r['שוכר']);
    s.leases.push({
      propertyKey, start, end: parseDate(r['end date']), rent, currency: 'USD',
      tenantKey: tenant ? s.party(tenant, C, { role: tenant === 'בית המלון' ? 'hotel' : 'tenant' }) : undefined,
      deposit: parseAmount(r['בטחון']), brokerage: parseAmount(r['תיווך מקומי']),
      collectDay: parseInt(r['Collect day'], 10) || undefined, notes: r.Notes || undefined,
    });
    s.count(C, 'leases');
  }
}
