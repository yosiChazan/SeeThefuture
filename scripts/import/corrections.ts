// Manual corrections to the Airtable data, decided with the office.
// Keys are Airtable primary-field values after cleanName(). Each entry notes
// the decision so the next run (and the next maintainer) knows why.

export interface Corrections {
  // Airtable record → apartment number to use instead of the parsed one.
  unitOverrides: Record<string, string>;
  // Records imported without an apartment number until it is known.
  allowMissingUnit: string[];
  // Two Airtable records that are one property. `keep` gives the primary name.
  mergeProperties: { keep: string; merge: string }[];
  // Numbers other sources use for a property (hotel statements, land registry).
  externalRefs: { property: string; source: string; key: string }[];
  // Spelling → canonical name. Merges the parties.
  partyAliases: Record<string, string>;
  // Georgia: leases of an owner with several units in one project. The nth
  // Airtable row with this property and start date goes to units[n].
  leaseUnits: { property: string; start: string; units: string[]; rent?: number }[];
  // A lease row whose start date is wrong in Airtable, found by property, start and rent.
  leaseStarts: { property: string; start: string; rent: number; newStart: string }[];
  // Canonical names that are companies, and our own people and companies.
  companies: string[];
  internal: string[];
}

export const corrections: Corrections = {
  unitOverrides: {
    // Two different apartments both recorded as Metropolis 3 / 882 (30.10.2026).
    'Ayala Malka Ravina-3 Metropolis-882': '882א',
    'Malka Langsam-3 Metropolis-882': '882ב',
    // Address has no "Apt"; the apartment is 10.
    '8 - Mircea Vulcanescu YOM TOV SRL': '10',
  },
  allowMissingUnit: [
    // Odessa city center; number not known yet.
    'Shmuel Frenkel--',
  ],
  mergeProperties: [
    // Same apartment entered twice; row 48 holds a document that 68 lacks.
    { keep: '68 - Vasile Lascar 23-25, Apt 4 FLINT YEHUDITH', merge: '48 - Vasile Lascar 23-25, Apt 4' },
  ],
  externalRefs: [
    // Airtable: floor 30, apt 23. The hotel's own serial number is 3607.
    { property: 'MOSHE ISRAEL ICKOVITCH - Alliance - Meroit Card yard', source: 'alliance_statement', key: '3607' },
  ],
  leaseUnits: [
    // Notes: "דירה 1505", rent 350 in winter and 450 in June–August; Airtable has "$350450".
    { property: 'Menachem Kleinman - Alliance - Meroit Card yard', start: '2024-04-08', units: ['1505'], rent: 350 },
    // Two identical rows, one per unit; same terms, so the order does not matter.
    { property: 'SHIMON YOCHNAN TZWEBNER - Alliance - Meroit Card yard', start: '2025-10-01', units: ['3519', '3505'] },
  ],
  leaseStarts: [
    // The extension was entered as a copy of the lease with the same start date.
    // Notes: from 01.08.2026 extended to 31.07.2027, rent 420 → 450 EUR (29.10.2026).
    { property: '19 - Ion Brezoianu 38A, 4th floor, Apt 10 CHAIM DAVID GROSMAN', start: '2025-07-21', rent: 450, newStart: '2026-08-01' },
  ],
  partyAliases: {
    'Ayala Ravina': 'Ayala Malka Ravina',
    'URI ISRAEL GOLOVENZITZ': 'Uri Golovenzitz',
    'Goloventziz Uri': 'Uri Golovenzitz',
    // Joint company of Uri Golovenzitz and Yaakov Sheinberger.
    'Golo&Sheinberger': 'Golovenzitz & Sheinberger',
    'Uri Golovenzitz&Yaakov Sheinberger': 'Golovenzitz & Sheinberger',
  },
  companies: ['Golovenzitz & Sheinberger'],
  internal: ['Uri Golovenzitz', 'SEE THE FUTURE LTD', 'YOM TOV SRL'],
};
