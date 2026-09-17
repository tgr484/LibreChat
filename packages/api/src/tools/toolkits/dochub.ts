import type { ExtendedJsonSchema } from '../registry/schema';

/**
 * DocHub tools: research inside one collection of the corporate document store.
 *
 * Descriptions are what the model actually reads, so they are in Russian (the
 * deployment language) and they carry the cost of each call — the model has to
 * know that `dochub_read` may run for minutes before it decides to call it ten
 * times. Every description can be overridden by an environment variable so a
 * prompt can be tuned on the server without a rebuild.
 */

const COLLECTION_PROPERTY: ExtendedJsonSchema = {
  type: 'string',
  description:
    'Коллекция DocHub: название так, как его назвал пользователь («Нефтяное хозяйство 2018»), или числовой id из dochub_collections.',
};

const DEFAULT_COLLECTIONS_DESCRIPTION = `Возвращает коллекции документов DocHub, доступные пользователю: свои, полученные по приглашению и публичные.

Вызывай, когда пользователь называет коллекцию словами или когда неясно, где искать. В ответе — название, id и число документов; дальше передавай название коллекции в остальные инструменты dochub_*.`;

const DEFAULT_SEARCH_DESCRIPTION = `Ищет документы внутри одной коллекции DocHub по смыслу и по словам.

Возвращает список документов: номер (№) в коллекции, название, причину попадания и короткий фрагмент. Полного текста не возвращает — это первый, дешёвый шаг любой задачи по коллекции.

Дальше: для глубокого разбора 1–3 отобранных документов вызывай dochub_read, для обобщения по всей коллекции — dochub_survey. Не запускай несколько поисков одновременно.`;

const DEFAULT_READ_DESCRIPTION = `Читает ОДИН документ коллекции DocHub вглубь — при необходимости целиком, по главам — и возвращает сжатую выжимку по заданному вопросу со ссылками на страницы оригинала.

Вызов дорогой: он может занять минуты. Вызывай его для 1–3 документов, отобранных через dochub_search, а не для всей коллекции. Вопрос формулируй конкретно — инструмент вернёт только относящееся к нему.

В ответе пользователю всегда называй документ номером и названием, например: №3 «Испытания турбодетандера», с. 14.`;

const DEFAULT_SURVEY_DESCRIPTION = `Обобщает, что говорят про заданный вопрос документы коллекции DocHub: сам выполняет поиск, разбирает отобранные документы и возвращает сводку с расхождениями между ними и ссылками на номера документов и страницы.

Для вопросов вида «обобщи, что в коллекции пишут про X». Один вызов может занять несколько минут; не повторяй его подряд по одной и той же коллекции — уточняй вопрос.`;

const describe = (variable: string, fallback: string): string => process.env[variable] || fallback;

const collectionsSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    filter: {
      type: 'string',
      description: 'Необязательно: подстрока названия, чтобы сузить список коллекций.',
    },
  },
  required: [],
};

const searchSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    collection: COLLECTION_PROPERTY,
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 1000,
      description:
        'Поисковый запрос на естественном языке. Ищется и по смыслу выжимок, и по словам в текстах документов.',
    },
    top_k: {
      type: 'integer',
      minimum: 1,
      maximum: 20,
      description: 'Сколько документов вернуть. По умолчанию 8, больше 20 не бывает.',
    },
  },
  required: ['collection', 'query'],
};

const readSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    collection: COLLECTION_PROPERTY,
    document: {
      type: 'string',
      description:
        'Номер документа (№) в коллекции — тот, что вернули dochub_search или dochub_collections. Можно указать точное название.',
    },
    question: {
      type: 'string',
      minLength: 3,
      description:
        'Что именно выяснить в этом документе. Чем конкретнее вопрос, тем полезнее ответ: инструмент читает документ и возвращает только относящееся к вопросу.',
    },
    scope: {
      type: 'string',
      enum: ['auto', 'full', 'summary'],
      description:
        'auto (по умолчанию) — глубина по объёму документа; full — прочитать весь документ по главам; summary — ограничиться выжимкой (быстро).',
    },
    pages: {
      type: 'string',
      pattern: '^\\d+(-\\d+)?$',
      description:
        'Необязательно: страницы оригинала, например «12-30». Указывай, только если пользователь назвал страницы.',
    },
  },
  required: ['collection', 'document', 'question'],
};

const surveySchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    collection: COLLECTION_PROPERTY,
    question: {
      type: 'string',
      minLength: 3,
      description: 'Вопрос, по которому нужно обобщить материал коллекции.',
    },
    max_documents: {
      type: 'integer',
      minimum: 1,
      maximum: 12,
      description: 'Сколько документов разобрать. По умолчанию 6; больше — дольше.',
    },
    depth: {
      type: 'string',
      enum: ['summaries', 'full'],
      description:
        'summaries (по умолчанию) — по выжимкам и ключевым главам; full — читать документы целиком, значительно дольше.',
    },
  },
  required: ['collection', 'question'],
};

export interface DochubToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schema: ExtendedJsonSchema;
}

export const dochubToolkit: {
  readonly dochub_collections: DochubToolDefinition;
  readonly dochub_search: DochubToolDefinition;
  readonly dochub_read: DochubToolDefinition;
  readonly dochub_survey: DochubToolDefinition;
} = {
  dochub_collections: {
    name: 'dochub_collections',
    description: describe('DOCHUB_COLLECTIONS_DESCRIPTION', DEFAULT_COLLECTIONS_DESCRIPTION),
    schema: collectionsSchema,
  },
  dochub_search: {
    name: 'dochub_search',
    description: describe('DOCHUB_SEARCH_DESCRIPTION', DEFAULT_SEARCH_DESCRIPTION),
    schema: searchSchema,
  },
  dochub_read: {
    name: 'dochub_read',
    description: describe('DOCHUB_READ_DESCRIPTION', DEFAULT_READ_DESCRIPTION),
    schema: readSchema,
  },
  dochub_survey: {
    name: 'dochub_survey',
    description: describe('DOCHUB_SURVEY_DESCRIPTION', DEFAULT_SURVEY_DESCRIPTION),
    schema: surveySchema,
  },
} as const;

export const DOCHUB_TOOLKIT_KEY = 'dochub' as const;

/**
 * System-prompt note merged in next to the tool definitions, the same way web
 * search explains its citation format: without it the model cites documents by
 * title alone, and a collection holds several issues of the same journal.
 */
export function buildDochubToolContext(): string {
  return `Материалы DocHub — корпоративное хранилище документов. Ссылаясь на документ, всегда называй его номер в коллекции вместе с названием и, если известна, страницу: [№3 «Испытания турбодетандера», с. 41]. Если у документа доступна только выжимка, скажи об этом пользователю. Не выдумывай номера документов и страниц — бери их из ответов инструментов dochub_*.`;
}
