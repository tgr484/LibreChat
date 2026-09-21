import type { CellObject, WorkSheet } from 'xlsx';
import type { SheetCell, SpreadsheetSpec } from './types';
import { XLSX_MIME_TYPE } from '~/files/mime';

export { XLSX_MIME_TYPE };

const SHEET_NAME_MAX = 31;
const COLUMN_WIDTH_MIN = 8;
const COLUMN_WIDTH_MAX = 60;

const cellLength = (cell: SheetCell): number => (cell == null ? 0 : String(cell).length);

const toCell = (value: SheetCell): CellObject | undefined => {
  if (value == null || value === '') {
    return undefined;
  }
  if (typeof value === 'number') {
    return { t: 'n', v: value };
  }
  if (typeof value === 'boolean') {
    return { t: 'b', v: value };
  }
  return value.startsWith('=') && value.length > 1
    ? { t: 'n', f: value.slice(1) }
    : { t: 's', v: value };
};

const columnWidths = (table: SheetCell[][]): Array<{ wch: number }> => {
  const columns = table.reduce((max, row) => Math.max(max, row.length), 0);
  return Array.from({ length: columns }, (_, column) => ({
    wch: Math.min(
      COLUMN_WIDTH_MAX,
      Math.max(COLUMN_WIDTH_MIN, ...table.map((row) => cellLength(row[column] ?? null) + 2)),
    ),
  }));
};

const buildSheet = (utils: typeof import('xlsx').utils, table: SheetCell[][]): WorkSheet => {
  const sheet: WorkSheet = {};
  table.forEach((row, r) =>
    row.forEach((value, c) => {
      const cell = toCell(value);
      if (cell) {
        sheet[utils.encode_cell({ r, c })] = cell;
      }
    }),
  );
  const columns = table.reduce((max, row) => Math.max(max, row.length), 0);
  sheet['!ref'] = utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: Math.max(table.length - 1, 0), c: Math.max(columns - 1, 0) },
  });
  sheet['!cols'] = columnWidths(table);
  return sheet;
};

/** Excel sheet names: at most 31 characters, none of `[]:*?/\\`, unique ignoring case. */
export const sheetNames = (names: readonly string[]): string[] => {
  const used = new Set<string>();
  return names.map((raw, index) => {
    const base =
      raw
        .replace(/[[\]:*?/\\]/g, ' ')
        .trim()
        .slice(0, SHEET_NAME_MAX) || `Лист${index + 1}`;
    let name = base;
    for (let suffix = 2; used.has(name.toLowerCase()); suffix++) {
      const tail = ` (${suffix})`;
      name = `${base.slice(0, SHEET_NAME_MAX - tail.length)}${tail}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
};

export async function buildSpreadsheet(spec: SpreadsheetSpec): Promise<Buffer> {
  const { utils, write } = await import('xlsx');
  const workbook = utils.book_new();
  const names = sheetNames(spec.sheets.map((sheet) => sheet.name));
  spec.sheets.forEach((sheet, index) => {
    const table: SheetCell[][] = sheet.header?.length ? [sheet.header, ...sheet.rows] : sheet.rows;
    utils.book_append_sheet(workbook, buildSheet(utils, table), names[index]);
  });
  return write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
