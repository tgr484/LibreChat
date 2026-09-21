import type {
  DocxAlign,
  DocxBlock,
  DocxSpec,
  SheetCell,
  SheetSpec,
  SpreadsheetSpec,
  PresentationColumn,
  PresentationLayout,
  PresentationSlide,
  PresentationSpec,
  PresentationTable,
} from './types';
import { parseIfJsonLike } from '~/utils/common';

/**
 * What a model actually sends. Local models (Qwen among them) regularly pass a
 * nested array or object as a JSON string, so every structured field may arrive
 * either parsed or stringified. The registry keeps the strict schema for the
 * model to read; this is only what execution accepts.
 */
export interface RawPresentationInput {
  title: string;
  subtitle?: string;
  filename?: string;
  slides: unknown;
}

export type PresentationParseResult =
  | { ok: true; spec: PresentationSpec }
  | { ok: false; error: string };

const LAYOUTS: ReadonlySet<PresentationLayout> = new Set([
  'bullets',
  'section',
  'two_columns',
  'table',
]);

export const PRESENTATION_LIMITS = {
  slides: 40,
  bullets: 10,
  sources: 6,
  columns: 6,
  rows: 12,
} as const;

type JsonObject = { [key: string]: unknown };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const unwrap = parseIfJsonLike;

const text = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
};

/** A list of lines; a plain string counts as one line per line break. */
function lines(value: unknown, limit: number): string[] {
  const unwrapped = unwrap(value);
  if (typeof unwrapped === 'string') {
    return unwrapped.split('\n').slice(0, limit);
  }
  if (!Array.isArray(unwrapped)) {
    return [];
  }
  return unwrapped
    .map(text)
    .filter((line): line is string => line != null)
    .slice(0, limit);
}

function column(value: unknown): PresentationColumn | undefined {
  const unwrapped = unwrap(value);
  if (Array.isArray(unwrapped) || typeof unwrapped === 'string') {
    return { bullets: lines(unwrapped, PRESENTATION_LIMITS.bullets) };
  }
  if (!isObject(unwrapped)) {
    return undefined;
  }
  return {
    heading: text(unwrapped.heading),
    bullets: lines(unwrapped.bullets, PRESENTATION_LIMITS.bullets),
  };
}

function table(value: unknown): PresentationTable | undefined {
  const unwrapped = unwrap(value);
  if (!isObject(unwrapped)) {
    return undefined;
  }
  const header = lines(unwrapped.header, PRESENTATION_LIMITS.columns);
  const rows = unwrap(unwrapped.rows);
  if (header.length === 0 || !Array.isArray(rows)) {
    return undefined;
  }
  return {
    header,
    rows: rows
      .slice(0, PRESENTATION_LIMITS.rows)
      .map((row) => lines(Array.isArray(unwrap(row)) ? row : [row], header.length)),
  };
}

function slide(value: unknown): PresentationSlide | undefined {
  const unwrapped = unwrap(value);
  if (!isObject(unwrapped)) {
    return undefined;
  }
  const title = text(unwrapped.title)?.trim();
  if (!title) {
    return undefined;
  }
  const layout = text(unwrapped.layout) as PresentationLayout | undefined;
  return {
    layout: layout && LAYOUTS.has(layout) ? layout : undefined,
    title,
    bullets: lines(unwrapped.bullets, PRESENTATION_LIMITS.bullets),
    left: column(unwrapped.left),
    right: column(unwrapped.right),
    table: table(unwrapped.table),
    notes: text(unwrapped.notes),
    sources: lines(unwrapped.sources, PRESENTATION_LIMITS.sources),
  };
}

/**
 * Accepts the model's arguments in whatever shape they arrived and returns the
 * deck, or an instruction the model can act on. A slide without a title is
 * dropped rather than failing the whole deck.
 */
export function parsePresentationInput(input: RawPresentationInput): PresentationParseResult {
  const slides = unwrap(input.slides);
  if (!Array.isArray(slides)) {
    return {
      ok: false,
      error:
        'Параметр slides должен быть массивом объектов слайдов, например [{"title": "…", "bullets": ["…"]}]. Повтори вызов.',
    };
  }
  const parsed = slides
    .slice(0, PRESENTATION_LIMITS.slides)
    .map(slide)
    .filter((entry): entry is PresentationSlide => entry != null);
  if (parsed.length === 0) {
    return {
      ok: false,
      error: 'В slides нет ни одного слайда с заголовком (title). Повтори вызов со слайдами.',
    };
  }
  return {
    ok: true,
    spec: {
      title: input.title,
      subtitle: input.subtitle,
      filename: input.filename,
      slides: parsed,
    },
  };
}

export interface RawDocumentInput {
  title: string;
  filename?: string;
  blocks: unknown;
}

export type DocumentParseResult = { ok: true; spec: DocxSpec } | { ok: false; error: string };

export const DOCUMENT_LIMITS = { blocks: 200, items: 50, columns: 8, rows: 100 } as const;

const ALIGNS: ReadonlySet<DocxAlign> = new Set(['left', 'center', 'right', 'justify']);

const align = (value: unknown): DocxAlign | undefined => {
  const name = text(value) as DocxAlign | undefined;
  return name && ALIGNS.has(name) ? name : undefined;
};

const flag = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') {
    return value;
  }
  return value === 'true' ? true : undefined;
};

function block(value: unknown): DocxBlock | undefined {
  const unwrapped = unwrap(value);
  if (!isObject(unwrapped)) {
    return undefined;
  }
  const content = text(unwrapped.text);
  switch (text(unwrapped.type)) {
    case 'heading': {
      const level = Number(unwrapped.level);
      return content?.trim()
        ? {
            type: 'heading',
            text: content,
            level: level === 2 || level === 3 ? level : 1,
            align: align(unwrapped.align),
          }
        : undefined;
    }
    case 'paragraph':
      return content != null
        ? {
            type: 'paragraph',
            text: content,
            align: align(unwrapped.align),
            bold: flag(unwrapped.bold),
            italic: flag(unwrapped.italic),
          }
        : undefined;
    case 'list': {
      const items = lines(unwrapped.items, DOCUMENT_LIMITS.items);
      return items.length > 0
        ? { type: 'list', items, ordered: flag(unwrapped.ordered) }
        : undefined;
    }
    case 'table': {
      const parsed = table(unwrapped);
      return parsed ? { type: 'table', ...parsed } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Accepts the model's arguments in whatever shape they arrived and returns the
 * document, or an instruction the model can act on. An unrecognised block is
 * dropped rather than failing the whole document.
 */
export function parseDocumentInput(input: RawDocumentInput): DocumentParseResult {
  const blocks = unwrap(input.blocks);
  if (!Array.isArray(blocks)) {
    return {
      ok: false,
      error:
        'Параметр blocks должен быть массивом блоков, например [{"type": "paragraph", "text": "…"}]. Повтори вызов.',
    };
  }
  const parsed = blocks
    .slice(0, DOCUMENT_LIMITS.blocks)
    .map(block)
    .filter((entry): entry is DocxBlock => entry != null);
  if (parsed.length === 0) {
    return {
      ok: false,
      error:
        'В blocks нет ни одного корректного блока (type: heading, paragraph, list или table). Повтори вызов.',
    };
  }
  return { ok: true, spec: { title: input.title, filename: input.filename, blocks: parsed } };
}

export interface RawSpreadsheetInput {
  title: string;
  filename?: string;
  sheets: unknown;
}

export type SpreadsheetParseResult =
  | { ok: true; spec: SpreadsheetSpec }
  | { ok: false; error: string };

export const SPREADSHEET_LIMITS = { sheets: 10, rows: 1000, columns: 40 } as const;

const NUMERIC = /^-?\d+(?:[.,]\d+)?$/;

/** Models send numbers as strings; a plain numeric string becomes a real number so it sums and sorts. */
const cell = (value: unknown): SheetCell => {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return NUMERIC.test(trimmed) ? Number(trimmed.replace(',', '.')) : value;
};

const row = (value: unknown): SheetCell[] | undefined => {
  const unwrapped = unwrap(value);
  return Array.isArray(unwrapped)
    ? unwrapped.slice(0, SPREADSHEET_LIMITS.columns).map(cell)
    : undefined;
};

function sheet(value: unknown, index: number): SheetSpec | undefined {
  const unwrapped = unwrap(value);
  if (!isObject(unwrapped)) {
    return undefined;
  }
  const rows = unwrap(unwrapped.rows);
  const header = lines(unwrapped.header, SPREADSHEET_LIMITS.columns);
  const parsedRows = Array.isArray(rows)
    ? rows
        .slice(0, SPREADSHEET_LIMITS.rows)
        .map(row)
        .filter((entry): entry is SheetCell[] => entry != null)
    : [];
  if (header.length === 0 && parsedRows.length === 0) {
    return undefined;
  }
  return {
    name: text(unwrapped.name) ?? `Лист${index + 1}`,
    header: header.length > 0 ? header : undefined,
    rows: parsedRows,
  };
}

/**
 * Accepts the model's arguments in whatever shape they arrived and returns the
 * workbook, or an instruction the model can act on. An empty sheet is dropped
 * rather than failing the whole workbook.
 */
export function parseSpreadsheetInput(input: RawSpreadsheetInput): SpreadsheetParseResult {
  const sheets = unwrap(input.sheets);
  if (!Array.isArray(sheets)) {
    return {
      ok: false,
      error:
        'Параметр sheets должен быть массивом листов, например [{"name": "Данные", "header": ["A", "B"], "rows": [[1, 2]]}]. Повтори вызов.',
    };
  }
  const parsed = sheets
    .slice(0, SPREADSHEET_LIMITS.sheets)
    .map(sheet)
    .filter((entry): entry is SheetSpec => entry != null);
  if (parsed.length === 0) {
    return {
      ok: false,
      error: 'В sheets нет ни одного листа с данными (header или rows). Повтори вызов.',
    };
  }
  return { ok: true, spec: { title: input.title, filename: input.filename, sheets: parsed } };
}
