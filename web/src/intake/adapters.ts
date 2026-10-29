import { parseGershon } from './gershon.ts';
import { parseItai } from './itai.ts';
import type { Book, ParseResult } from './types.ts';
import { parseVitaly } from './vitaly.ts';

// Adapters by the `adapter` column of app.import_sources. Sources without one here
// (the hotels, the manual forms) are listed as coming later.
export const ADAPTERS: Record<string, { parse: (book: Book, fileName: string) => ParseResult; accept: string; example: string }> = {
  vitaly_rent_xlsx: { parse: parseVitaly, accept: '.xlsx', example: '2026_RENT_JANUARY_PLC.xlsx' },
  gershon_utilities_xlsx: { parse: parseGershon, accept: '.xlsx', example: 'Utilities_PLC_January_2026.xlsx' },
  itai_client_xlsx: { parse: parseItai, accept: '.xlsx', example: '<Owner> - properties table.xlsx' },
};
