import type {
  PresentationColumn,
  PresentationLayout,
  PresentationSlide,
  PresentationSpec,
  PresentationTable,
} from './types';

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

/** Parses a JSON-looking string; anything else comes back unchanged. */
function unwrap(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

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
