import { parseGershon } from './gershon.ts';
import { parseItai } from './itai.ts';
import type { Book, ParseResult } from './types.ts';
import { parseVitaly } from './vitaly.ts';

// Adapters by the `adapter` column of app.import_sources. Sources without one here
// (the hotels, the manual forms) are listed as coming later.
// `drive`: the Drive folder where the office keeps this manager's reports, opened in a new
// tab from the report dialog (SPEC decision 89). The parent folder, so it holds every year.
export const ADAPTERS: Record<string, { parse: (book: Book, fileName: string) => ParseResult; accept: string; example: string; drive?: string }> = {
  vitaly_rent_xlsx: { parse: parseVitaly, accept: '.xlsx', example: '2026_RENT_JANUARY_PLC.xlsx', drive: 'https://drive.google.com/drive/folders/1w3D_hm45NPDuieEl-HX4XEf9eZZGL1fN' },
  gershon_utilities_xlsx: { parse: parseGershon, accept: '.xlsx', example: 'Utilities_PLC_January_2026.xlsx', drive: 'https://drive.google.com/drive/folders/1a1XSo6lNulaLPijV37KkgxitK2shXl3_' },
  itai_client_xlsx: { parse: parseItai, accept: '.xlsx', example: '<Owner> - properties table.xlsx' },
};
