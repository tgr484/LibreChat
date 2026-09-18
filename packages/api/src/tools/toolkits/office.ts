import type { ExtendedJsonSchema } from '../registry/schema';

/**
 * Office file tools. The model supplies structured content; the server lays it
 * out with a fixed minimalist theme and attaches the file to the reply, so the
 * model never writes layout code and the deck looks the same every time.
 */

const DEFAULT_PRESENTATION_DESCRIPTION = `Создаёт презентацию PowerPoint (.pptx) и прикрепляет файл к ответу. Оформление задаётся сервером (минималистичный стиль) — передавай только содержание.

Первый слайд с названием и подзаголовком строится автоматически; в slides перечисли остальные слайды. Макеты:
- bullets — заголовок и 3–6 коротких тезисов (по умолчанию);
- section — разделитель между частями: заголовок и, при желании, одна поясняющая строка в bullets;
- two_columns — сравнение: left и right, у каждой колонки свой заголовок и тезисы;
- table — таблица: header и rows, не больше 8 строк и 6 столбцов.

Тезис — одна мысль, до 150 символов, без markdown. Подробности и формулировки для выступления выноси в notes. Если слайд опирается на документы, укажи их в sources в виде «№3 «Название», с. 41» — они печатаются мелким шрифтом внизу слайда.

Содержание готовь заранее: собери материал (например, через dochub_survey или dochub_read), затем вызови инструмент один раз со всей презентацией. После вызова не пересказывай слайды целиком — кратко опиши структуру и предложи правки.`;

const describe = (variable: string, fallback: string): string => process.env[variable] || fallback;

const bulletsProperty = (description: string): ExtendedJsonSchema => ({
  type: 'array',
  maxItems: 10,
  items: { type: 'string' },
  description,
});

const columnSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    heading: { type: 'string', description: 'Заголовок колонки.' },
    bullets: bulletsProperty('Тезисы колонки.'),
  },
  required: ['bullets'],
};

const slideSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    layout: {
      type: 'string',
      enum: ['bullets', 'section', 'two_columns', 'table'],
      description: 'Макет слайда; по умолчанию bullets.',
    },
    title: { type: 'string', minLength: 1, description: 'Заголовок слайда.' },
    bullets: bulletsProperty(
      'Тезисы для bullets; для section — одна поясняющая строка. Каждый тезис — отдельный элемент, без маркеров «-» и «•».',
    ),
    left: { ...columnSchema, description: 'Левая колонка для two_columns.' },
    right: { ...columnSchema, description: 'Правая колонка для two_columns.' },
    table: {
      type: 'object',
      description: 'Таблица для table.',
      properties: {
        header: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          items: { type: 'string' },
          description: 'Заголовки столбцов.',
        },
        rows: {
          type: 'array',
          maxItems: 12,
          items: { type: 'array', maxItems: 6, items: { type: 'string' } },
          description: 'Строки таблицы; в каждой столько же ячеек, сколько заголовков.',
        },
      },
      required: ['header', 'rows'],
    },
    notes: {
      type: 'string',
      description: 'Заметки докладчика: что сказать на этом слайде. На слайде не видны.',
    },
    sources: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string' },
      description: 'Источники слайда, например «№3 «Испытания турбодетандера», с. 41».',
    },
  },
  required: ['title'],
};

const presentationSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      description: 'Название презентации — крупно на титульном слайде и в нижнем колонтитуле.',
    },
    subtitle: {
      type: 'string',
      description: 'Подзаголовок титульного слайда: тема, основание, дата или автор.',
    },
    slides: {
      type: 'array',
      minItems: 1,
      maxItems: 40,
      items: slideSchema,
      description: 'Слайды после титульного, по порядку.',
    },
    filename: {
      type: 'string',
      description: 'Необязательно: имя файла без расширения. По умолчанию — название презентации.',
    },
  },
  required: ['title', 'slides'],
};

export interface OfficeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schema: ExtendedJsonSchema;
  readonly responseFormat: 'content_and_artifact';
}

export const officeToolkit: {
  readonly create_presentation: OfficeToolDefinition;
} = {
  create_presentation: {
    name: 'create_presentation',
    description: describe('CREATE_PRESENTATION_DESCRIPTION', DEFAULT_PRESENTATION_DESCRIPTION),
    schema: presentationSchema,
    responseFormat: 'content_and_artifact' as const,
  },
} as const;
