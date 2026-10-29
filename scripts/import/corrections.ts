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
