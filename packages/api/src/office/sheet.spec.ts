import JSZip from 'jszip';
import type { ToolMessage } from '@langchain/core/messages';
import type { IMongoFile } from '@librechat/data-schemas';
import type { SpreadsheetSpec } from './types';
import type { GeneratedFile } from './tool';
import { buildSpreadsheet, sheetNames, XLSX_MIME_TYPE } from './sheet';
import { createSpreadsheetTool, spreadsheetFilename } from './tool';
import { parseSpreadsheetInput, SPREADSHEET_LIMITS } from './input';
import { toolDefinitions } from '~/tools/registry/definitions';
import { OFFICE_TOOL_NAMES } from '~/tools/toolkits/office';

const spec: SpreadsheetSpec = {
  title: 'Отпуска сотрудников',
  sheets: [
    {
      name: 'График',
      header: ['ФИО', 'Дней', 'Ставка'],
      rows: [
        ['Иванов И. И.', 28, 100],
        ['Петров П. П.', 14, 100],
        ['Итого', '=SUM(B2:B3)', null],
      ],
    },
  ],
};

const sheetXml = async (buffer: Buffer): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer);
  return (await zip.file('xl/worksheets/sheet1.xml')?.async('string')) ?? '';
};

describe('buildSpreadsheet', () => {
  it('writes cells, a formula and column widths', async () => {
    const buffer = await buildSpreadsheet(spec);
    const xml = await sheetXml(buffer);

    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    expect(xml).toContain('<f>SUM(B2:B3)</f>');
    expect(xml).toContain('<cols>');
    expect(xml).toContain('<v>28</v>');
  });

  it('makes sheet names valid and unique', () => {
    expect(sheetNames(['a/b', 'A/B', '', 'x'.repeat(40)])).toEqual([
      'a b',
      'A B (2)',
      'Лист3',
      'x'.repeat(31),
    ]);
  });
});

describe('parseSpreadsheetInput', () => {
  it('accepts stringified sheets and turns numeric strings into numbers', () => {
    const result = parseSpreadsheetInput({
      title: 'T',
      sheets: JSON.stringify([{ name: 'S', header: ['a'], rows: [['1,5', 'text', '2']] }]),
    });
    expect(result).toMatchObject({
      ok: true,
      spec: { sheets: [{ name: 'S', rows: [[1.5, 'text', 2]] }] },
    });
  });

  it('returns an actionable error when there is no data', () => {
    expect(parseSpreadsheetInput({ title: 'T', sheets: [] })).toMatchObject({ ok: false });
    expect(parseSpreadsheetInput({ title: 'T', sheets: 'x' })).toMatchObject({ ok: false });
  });
});

describe('createSpreadsheetTool', () => {
  const invoke = async (
    saveFile: (file: GeneratedFile) => Promise<IMongoFile>,
  ): Promise<ToolMessage> =>
    (await createSpreadsheetTool({ saveFile }).invoke({
      id: 'call_1',
      name: 'create_spreadsheet',
      args: spec,
      type: 'tool_call',
    })) as ToolMessage;

  it('saves the xlsx with a preview', async () => {
    const saved: GeneratedFile[] = [];
    await invoke(async (file) => {
      saved.push(file);
      return { file_id: 'f1' } as IMongoFile;
    });
    expect(saved[0].type).toBe(XLSX_MIME_TYPE);
    expect(saved[0].filename).toBe('Отпуска_сотрудников.xlsx');
    expect(saved[0].text).toContain('Иванов');
  });

  it('reports failure when storage throws', async () => {
    const message = await invoke(async () => {
      throw new Error('disk full');
    });
    expect(String(message.content)).toContain('Не удалось создать таблицу');
  });
});

describe('create_spreadsheet registration', () => {
  it('is a builtin tool and part of the office set', () => {
    expect(toolDefinitions.create_spreadsheet.toolType).toBe('builtin');
    expect(OFFICE_TOOL_NAMES).toContain('create_spreadsheet');
    expect(spreadsheetFilename({ title: 'x', filename: 'a b.xls', sheets: [] })).toBe('a_b.xlsx');
  });
});

describe('large workbooks are never truncated', () => {
  const grid = (rows: number, columns: number): string[][] =>
    Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => `r${r}c${c}`));

  it('keeps 2000 rows x 50 columns', async () => {
    const result = parseSpreadsheetInput({
      title: 'T',
      sheets: [{ name: 'S', header: grid(1, 50)[0], rows: grid(2000, 50) }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const xml = await sheetXml(await buildSpreadsheet(result.spec));
    expect(xml.match(/<row /g)).toHaveLength(2001);
    expect(xml).toContain('r1999c49');
  });

  it('refuses, rather than truncates, past the sanity limits', () => {
    const result = parseSpreadsheetInput({
      title: 'T',
      sheets: [{ name: 'S', rows: grid(SPREADSHEET_LIMITS.rows + 1, 1) }],
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain('ничего не обрезано');
  });
});
