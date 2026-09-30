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

const DEFAULT_DOCUMENT_DESCRIPTION = `Создаёт документ Word (.docx) и прикрепляет файл к ответу. Шрифт, поля и отступы задаёт сервер (деловой стиль, Times New Roman 14) — передавай только содержание и выравнивание.

Документ — это последовательность blocks по порядку сверху вниз:
- heading — заголовок: text, level 1–3, align;
- paragraph — абзац: text, align (left, center, right, justify), bold, italic; перенос строки внутри абзаца — «\\n» (так делаются реквизиты и подписи);
- list — список: items, ordered (true — нумерованный);
- table — таблица: header и rows.

Для официальных бумаг (заявление, служебная записка, приказ) собери «шапку» адресата одним paragraph с align: right, заголовок «Заявление» — heading с align: center, текст — paragraph с align: justify, дату и подпись — отдельный paragraph. Неизвестные данные (даты, подписи) оставляй пустой линией «_____», не выдумывай их.

Вызывай инструмент один раз с полным документом. После вызова не пересказывай текст целиком — кратко скажи, что в файле, и попроси проверить данные.`;

const DEFAULT_SPREADSHEET_DESCRIPTION = `Создаёт таблицу Excel (.xlsx) и прикрепляет файл к ответу. Ширину столбцов подбирает сервер — передавай только данные.

Таблица состоит из листов (sheets). У листа: name (до 31 символа), header — заголовки столбцов, rows — строки, каждая строка — массив ячеек. Ячейка — строка, число или true/false; пустую ячейку оставь пустой строкой. Числа передавай числами, а не текстом, чтобы по ним можно было считать и сортировать.

Формула — строка, начинающаяся с «=», в английской записи: «=SUM(B2:B10)», «=B2*C2». Ссылки на ячейки считай с учётом заголовка: он занимает строку 1, первая строка данных — строка 2.

Вызывай инструмент один раз со всеми листами. После вызова не пересказывай данные — кратко скажи, что в таблице.`;

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

const documentSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      description:
        'Название документа: свойство файла и имя файла по умолчанию. В тексте не печатается.',
    },
    blocks: {
      type: 'array',
      minItems: 1,
      maxItems: 2000,
      description: 'Блоки документа сверху вниз.',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['heading', 'paragraph', 'list', 'table'] },
          text: { type: 'string', description: 'Текст для heading и paragraph.' },
          level: {
            type: 'integer',
            enum: [1, 2, 3],
            description: 'Уровень heading; по умолчанию 1.',
          },
          align: {
            type: 'string',
            enum: ['left', 'center', 'right', 'justify'],
            description: 'Выравнивание heading и paragraph; по умолчанию left.',
          },
          bold: { type: 'boolean', description: 'Жирный текст paragraph.' },
          italic: { type: 'boolean', description: 'Курсив paragraph.' },
          items: {
            type: 'array',
            maxItems: 1000,
            items: { type: 'string' },
            description: 'Пункты list без маркеров и номеров.',
          },
          ordered: { type: 'boolean', description: 'list: true — нумерованный.' },
          header: {
            type: 'array',
            minItems: 1,
            maxItems: 30,
            items: { type: 'string' },
            description: 'Заголовки столбцов table.',
          },
          rows: {
            type: 'array',
            maxItems: 5000,
            items: { type: 'array', maxItems: 30, items: { type: 'string' } },
            description: 'Строки table; в каждой столько же ячеек, сколько заголовков.',
          },
        },
        required: ['type'],
      },
    },
    filename: {
      type: 'string',
      description: 'Необязательно: имя файла без расширения. По умолчанию — title.',
    },
  },
  required: ['title', 'blocks'],
};

const spreadsheetSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      description: 'Название таблицы: имя файла по умолчанию.',
    },
    sheets: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      description: 'Листы книги по порядку.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Название листа, до 31 символа.' },
          header: {
            type: 'array',
            maxItems: 200,
            items: { type: 'string' },
            description: 'Заголовки столбцов.',
          },
          rows: {
            type: 'array',
            maxItems: 50000,
            description: 'Строки данных; каждая строка — массив ячеек.',
            items: {
              type: 'array',
              maxItems: 200,
              items: {},
            },
          },
        },
        required: ['name', 'rows'],
      },
    },
    filename: {
      type: 'string',
      description: 'Необязательно: имя файла без расширения. По умолчанию — title.',
    },
  },
  required: ['title', 'sheets'],
};

export interface OfficeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schema: ExtendedJsonSchema;
  readonly responseFormat: 'content_and_artifact';
}

export const officeToolkit: {
  readonly create_presentation: OfficeToolDefinition;
  readonly create_document: OfficeToolDefinition;
  readonly create_spreadsheet: OfficeToolDefinition;
} = {
  create_presentation: {
    name: 'create_presentation',
    description: describe('CREATE_PRESENTATION_DESCRIPTION', DEFAULT_PRESENTATION_DESCRIPTION),
    schema: presentationSchema,
    responseFormat: 'content_and_artifact' as const,
  },
  create_document: {
    name: 'create_document',
    description: describe('CREATE_DOCUMENT_DESCRIPTION', DEFAULT_DOCUMENT_DESCRIPTION),
    schema: documentSchema,
    responseFormat: 'content_and_artifact' as const,
  },
  create_spreadsheet: {
    name: 'create_spreadsheet',
    description: describe('CREATE_SPREADSHEET_DESCRIPTION', DEFAULT_SPREADSHEET_DESCRIPTION),
    schema: spreadsheetSchema,
    responseFormat: 'content_and_artifact' as const,
  },
} as const;

/** Tools equipped together by the chat's Office documents toggle and a spec's `office` flag. */
export const OFFICE_TOOL_NAMES: readonly string[] = [
  officeToolkit.create_document.name,
  officeToolkit.create_presentation.name,
  officeToolkit.create_spreadsheet.name,
];
