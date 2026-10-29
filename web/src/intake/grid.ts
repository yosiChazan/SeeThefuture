import type { Worksheet } from 'exceljs';
import type { Book, Grid } from './types.ts';

type Cell = string | number | null;

// Plain data form of a sheet, used by the tests' fixtures.
export interface GridJson { sheet: string; cells: Record<string, Cell>; formulas?: Record<string, string> }

const key = (r: number, c: number) => `${r},${c}`;

export function bookOf(sheets: Grid[]): Book {
  return { sheets, sheet: (name) => sheets.find((s) => name.test(s.sheet)) };
}

export const bookFromJson = (j: GridJson | GridJson[]): Book => bookOf((Array.isArray(j) ? j : [j]).map(gridFromJson));

export function gridFromJson(j: GridJson): Grid {
  let rows = 0; let cols = 0;
  for (const k of Object.keys(j.cells)) { const [r, c] = k.split(',').map(Number); rows = Math.max(rows, r); cols = Math.max(cols, c); }
  return {
    sheet: j.sheet, rows, cols,
    value: (r, c) => j.cells[key(r, c)] ?? null,
    formula: (r, c) => j.formulas?.[key(r, c)] ?? null,
  };
}

// Reads every worksheet of an .xlsx in the browser. ExcelJS is loaded only
// when someone opens the intake screen.
export async function bookFromXlsx(data: ArrayBuffer): Promise<Book> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  return bookOf(wb.worksheets.map(sheetToGrid));
}

function sheetToGrid(ws: Worksheet): Grid {
  const cells: Record<string, Cell> = {};
  const formulas: Record<string, string> = {};
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      // ExcelJS repeats a merged cell's value in every cell of the range; the
      // adapters expect it once, in the top-left cell, as Excel shows it.
      if (cell.isMerged && cell.master.address !== cell.address) return;
      const v = cell.value as unknown;
      let out: Cell = null;
      if (v === null || v === undefined) out = null;
      else if (typeof v === 'number' || typeof v === 'string') out = v;
      else if (v instanceof Date) out = v.toISOString().slice(0, 10);
      else if (typeof v === 'object') {
        const o = v as { formula?: string; sharedFormula?: string; result?: unknown; richText?: { text: string }[]; text?: string };
        if (o.formula || o.sharedFormula) {
          formulas[key(r, c)] = `=${o.formula ?? o.sharedFormula}`;
          const res = o.result as unknown;
          out = typeof res === 'number' || typeof res === 'string' ? res : res instanceof Date ? res.toISOString().slice(0, 10) : null;
        } else if (o.richText) out = o.richText.map((t) => t.text).join('');
        else if (o.text !== undefined) out = String(o.text);
      }
      if (out !== null) cells[key(r, c)] = out;
    });
  });
  return gridFromJson({ sheet: ws.name, cells, formulas });
}
