import { logger } from '@librechat/data-schemas';
import { tool } from '@librechat/agents/langchain/tools';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type {
  DochubAgentSettings,
  DochubCollectionSummary,
  DochubDocumentRef,
  DochubSearchResponse,
} from './types';
import type { DochubCatalog, DochubCatalogStore, DochubCollectionResolution } from './catalog';
import type { DochubDocumentResolution } from './catalog';
import type { DochubLlm, DochubLlmAgent } from './llm';
import type { DochubResolvedConfig } from './config';
import type { DochubSurveyDepth } from './survey';
import type { EndpointDbMethods } from '~/types';
import type { DochubReadScope } from './reader';
import type { ServerRequest } from '~/types';
import type { DochubClient } from './client';
import type { RunBudget } from './budget';
import { createDochubCatalog, createDochubCatalogStore } from './catalog';
import { isDochubConfigured, resolveDochubConfig } from './config';
import { formatSurveyResult, surveyCollection } from './survey';
import { formatReadResult, readDocument } from './reader';
import { DochubError, describeForModel } from './errors';
import { dochubToolkit } from '~/tools/toolkits/dochub';
import { resolveDochubSubject } from './token';
import { createDochubClient } from './client';
import { createRunBudget } from './budget';
import { resolveDochubLlm } from './llm';

/**
 * One catalog per chat turn: several tool calls must not re-list the collections.
 * Keyed by the DocHub login as well, so a listing can never be served to anyone
 * but the user it was fetched for.
 */
const CATALOG_STORE = Symbol.for('librechat.dochub.catalog');

const NOT_LDAP_MESSAGE =
  'Интеграция с DocHub доступна только пользователям, вошедшим через корпоративную учётную запись (LDAP). Сообщи об этом пользователю и не повторяй вызов.';
const NO_IDENTITY_MESSAGE =
  'Учётная запись пользователя не сопоставлена с логином DocHub — нужен администратор. Сообщи об этом пользователю и не повторяй вызов.';
const NO_LLM_MESSAGE =
  'Не удалось подключить модель для чтения документов DocHub. Сообщи пользователю, что глубокое чтение сейчас недоступно, и опирайся на dochub_search.';
/** The schema allows 12; the config cannot raise it past that. */
const SURVEY_MAX_DOCUMENTS = 12;

interface ToolContext {
  client: DochubClient;
  catalog: DochubCatalog;
  budget: RunBudget;
  config: DochubResolvedConfig;
}

function storeFor(req: ServerRequest, sub: string): DochubCatalogStore {
  const holder = req as unknown as Record<symbol, Map<string, DochubCatalogStore> | undefined>;
  const stores = holder[CATALOG_STORE] ?? new Map<string, DochubCatalogStore>();
  holder[CATALOG_STORE] = stores;
  const existing = stores.get(sub);
  if (existing) {
    return existing;
  }
  const created = createDochubCatalogStore();
  stores.set(sub, created);
  return created;
}

/**
 * Every tool call gets its own budget, client and abort chain; the catalog is
 * the only thing shared across the calls of one turn.
 */
async function withContext(
  params: { req: ServerRequest; signal?: AbortSignal; toolName: string },
  handler: (context: ToolContext) => Promise<string>,
): Promise<string> {
  const config = resolveDochubConfig(params.req.config?.dochub);
  if (!config) {
    return 'Интеграция с DocHub не настроена на этом сервере. Сообщи об этом пользователю.';
  }

  const subject = resolveDochubSubject(params.req.user);
  if (!subject.ok) {
    logger.warn(`[dochub] ${params.toolName} refused: subject ${subject.reason}`);
    return subject.reason === 'not_ldap' ? NOT_LDAP_MESSAGE : NO_IDENTITY_MESSAGE;
  }

  const budget = createRunBudget({
    limits: config.runtime.limits,
    parentSignal: params.signal,
  });
  const client = createDochubClient({
    config: config.runtime,
    key: config.key,
    subject,
    budget,
  });
  const catalog = createDochubCatalog({ client, store: storeFor(params.req, subject.sub) });
  const startedAt = Date.now();

  try {
    return await handler({ client, catalog, budget, config });
  } catch (error) {
    if (error instanceof DochubError) {
      return describeForModel(error);
    }
    /** A programmer error must not take the whole chat run down with it. */
    logger.error(`[dochub] ${params.toolName} failed`, error);
    return 'Не удалось выполнить запрос к DocHub из-за внутренней ошибки. Сообщи об этом пользователю.';
  } finally {
    const spent = budget.spent();
    logger.info(
      `[dochub] tool=${params.toolName} sub=${subject.sub} http=${spent.http} llm=${spent.llm} ms=${Date.now() - startedAt}`,
    );
    budget.dispose();
  }
}

const describeCollection = (collection: DochubCollectionSummary): string => {
  const description = collection.description?.trim();
  const owner = collection.owner_username ? `, владелец: ${collection.owner_username}` : '';
  const tail = description ? ` — ${description.slice(0, 120)}` : '';
  return `- «${collection.name}» (id ${collection.id}, документов: ${collection.document_count}${owner})${tail}`;
};

function formatCollections(
  sections: ReadonlyArray<[string, DochubCollectionSummary[]]>,
  filter: string | undefined,
): string {
  const wanted = filter?.trim().toLowerCase();
  const lines: string[] = [];
  let shown = 0;

  for (const [title, collections] of sections) {
    const matching = wanted
      ? collections.filter((collection) => collection.name.toLowerCase().includes(wanted))
      : collections;
    if (matching.length === 0) {
      continue;
    }
    lines.push(`${title}:`);
    for (const collection of matching.slice(0, 40 - shown)) {
      lines.push(describeCollection(collection));
      shown += 1;
    }
    if (matching.length > 40 - shown) {
      lines.push(`  …и ещё ${matching.length - (40 - shown)}`);
    }
  }

  if (lines.length === 0) {
    return wanted
      ? `Коллекций с «${filter}» в названии нет. Покажи пользователю полный список, вызвав dochub без фильтра.`
      : 'У пользователя нет доступных коллекций DocHub.';
  }
  return lines.join('\n');
}

/** Turns a failed name lookup into something the model can act on. */
function describeCollectionMiss(resolution: DochubCollectionResolution & { ok: false }): string {
  const list = resolution.candidates
    .map((collection) => `- «${collection.name}» (id ${collection.id})`)
    .join('\n');
  if (resolution.reason === 'ambiguous') {
    return `Под это название подходит несколько коллекций DocHub. Уточни у пользователя, какая нужна:\n${list}`;
  }
  return `Такой коллекции в DocHub нет. Доступные коллекции:\n${list}`;
}

function formatSearch(
  collectionName: string,
  collectionId: number,
  response: DochubSearchResponse,
): string {
  if (response.hits.length === 0) {
    return `Коллекция «${collectionName}» (id ${collectionId}): по запросу ничего не найдено. Попробуй другие формулировки или проверь коллекцию через dochub.`;
  }

  const lines = [
    `Коллекция «${collectionName}» (id ${collectionId}). Найдено документов: ${response.hits.length}.`,
  ];
  for (const hit of response.hits) {
    const closed = hit.can_open ? '' : ' — ПОЛНЫЙ ТЕКСТ НЕДОСТУПЕН, есть только выжимка';
    lines.push(`№${hit.seq} «${hit.title}» (релевантность ${hit.score.toFixed(2)})${closed}`);
    lines.push(`   Причина: ${hit.match_reason}`);
    const snippet = hit.snippets[0]?.trim();
    if (snippet) {
      lines.push(`   Фрагмент: ${snippet.slice(0, 200)}`);
    }
  }
  if (response.degraded) {
    lines.push(
      'Примечание: поиск выполнен без разбора запроса, результаты могут быть грубее. При необходимости переформулируй запрос.',
    );
  }
  return lines.join('\n');
}

export interface CreateDochubToolsParams {
  req: ServerRequest;
  signal?: AbortSignal;
  /** The calling agent: its endpoint and model run the sub-agents by default. */
  agent?: DochubLlmAgent;
  /** Credential lookups for user-provided endpoint keys. */
  db?: EndpointDbMethods;
  /** Test seam: replaces model resolution, never used by the server. */
  resolveLlm?: (settings: DochubAgentSettings) => Promise<DochubLlm>;
}

function describeDocumentMiss(
  collectionName: string,
  resolution: DochubDocumentResolution & { ok: false },
): string {
  const list = resolution.candidates
    .slice(0, 15)
    .map((ref) => `- №${ref.seq} «${ref.title}»`)
    .join('\n');
  if (resolution.reason === 'ambiguous') {
    return `Под это описание в коллекции «${collectionName}» подходит несколько документов. Уточни номер:\n${list}`;
  }
  const hint = list ? `\nДокументы коллекции (первые):\n${list}` : '';
  return `Такого документа в коллекции «${collectionName}» нет. Найди нужный через dochub_search и передай его номер (№).${hint}`;
}

/** "12-30" or "12"; anything else was already refused by the schema pattern. */
export function parsePages(value: string | undefined): { from: number; to?: number } | undefined {
  const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(value ?? '');
  if (!match) {
    return undefined;
  }
  const from = Number(match[1]);
  const to = match[2] != null ? Number(match[2]) : undefined;
  return to != null && to < from ? { from: to, to: from } : { from, to };
}

/**
 * The four tools the chat model sees. They are created only when the
 * integration is configured — `loadAndFormatTools` keeps them out of the tool
 * cache in that case, and this is the second line of defence for an agent that
 * still lists them.
 */
export function createDochubTools(params: CreateDochubToolsParams): DynamicStructuredTool[] {
  const { req, signal, agent, db } = params;
  if (!isDochubConfigured(req.config)) {
    logger.warn('[dochub] tools requested while the integration is not configured');
    return [];
  }

  const collections = tool(
    async ({ filter }: { filter?: string }) =>
      withContext({ req, signal, toolName: 'dochub' }, async ({ catalog }) => {
        const response = await catalog.listCollections();
        return formatCollections(
          [
            ['Свои коллекции', response.my],
            ['Доступные по приглашению', response.shared_with_me],
            ['Публичные', response.public],
          ],
          filter,
        );
      }),
    {
      name: dochubToolkit.dochub.name,
      description: dochubToolkit.dochub.description,
      schema: dochubToolkit.dochub.schema,
    },
  );

  const search = tool(
    async ({
      collection,
      query,
      top_k: topK,
    }: {
      collection: string;
      query: string;
      top_k?: number;
    }) =>
      withContext({ req, signal, toolName: 'dochub_search' }, async (context) => {
        const resolved = await context.catalog.resolveCollection(collection);
        if (!resolved.ok) {
          return describeCollectionMiss(resolved);
        }
        const settings = context.config.runtime.search;
        const limited = Math.min(topK ?? settings.defaultTopK, settings.maxTopK);
        const response = await context.client.search(resolved.id, query, limited);
        context.catalog.registerHits(resolved.id, response.hits);
        return formatSearch(resolved.name, resolved.id, response);
      }),
    {
      name: dochubToolkit.dochub_search.name,
      description: dochubToolkit.dochub_search.description,
      schema: dochubToolkit.dochub_search.schema,
    },
  );

  const resolveLlm =
    params.resolveLlm ??
    (async (settings: DochubAgentSettings): Promise<DochubLlm> => {
      if (!db) {
        throw new Error('DocHub sub-agent needs credential lookups (db)');
      }
      return resolveDochubLlm({ req, agent, settings, db });
    });

  const loadLlm = async (settings: DochubAgentSettings): Promise<DochubLlm | undefined> => {
    try {
      return await resolveLlm(settings);
    } catch (error) {
      logger.error('[dochub] sub-agent model resolution failed', error);
      return undefined;
    }
  };

  const read = tool(
    async ({
      collection,
      document,
      question,
      scope,
      pages,
    }: {
      collection: string;
      document: string;
      question: string;
      scope?: DochubReadScope;
      pages?: string;
    }) =>
      withContext({ req, signal, toolName: 'dochub_read' }, async (context) => {
        const resolved = await context.catalog.resolveCollection(collection);
        if (!resolved.ok) {
          return describeCollectionMiss(resolved);
        }
        const found = await context.catalog.resolveDocument(resolved.id, document);
        if (!found.ok) {
          return describeDocumentMiss(resolved.name, found);
        }
        const llm = await loadLlm(context.config.runtime.agent);
        if (!llm) {
          return NO_LLM_MESSAGE;
        }
        const { limits } = context.config.runtime;
        const result = await readDocument({
          ref: { ...found.ref, collectionName: resolved.name },
          question,
          scope: scope ?? 'auto',
          pages: parsePages(pages),
          client: context.client,
          llm,
          budget: context.budget,
          limits,
        });
        return formatReadResult(result, question, limits.resultCharLimit);
      }),
    {
      name: dochubToolkit.dochub_read.name,
      description: dochubToolkit.dochub_read.description,
      schema: dochubToolkit.dochub_read.schema,
    },
  );

  const survey = tool(
    async ({
      collection,
      question,
      max_documents: maxDocuments,
      depth,
    }: {
      collection: string;
      question: string;
      max_documents?: number;
      depth?: DochubSurveyDepth;
    }) =>
      withContext({ req, signal, toolName: 'dochub_survey' }, async (context) => {
        const resolved = await context.catalog.resolveCollection(collection);
        if (!resolved.ok) {
          return describeCollectionMiss(resolved);
        }
        const llm = await loadLlm(context.config.runtime.agent);
        if (!llm) {
          return NO_LLM_MESSAGE;
        }
        const { limits, search } = context.config.runtime;
        const result = await surveyCollection({
          collectionId: resolved.id,
          collectionName: resolved.name,
          question,
          maxDocuments: Math.min(maxDocuments ?? limits.maxDocuments, SURVEY_MAX_DOCUMENTS),
          depth: depth ?? 'summaries',
          client: context.client,
          catalog: context.catalog,
          llm,
          budget: context.budget,
          limits,
          search,
        });
        return formatSurveyResult(result, context.budget.notes(), limits.resultCharLimit);
      }),
    {
      name: dochubToolkit.dochub_survey.name,
      description: dochubToolkit.dochub_survey.description,
      schema: dochubToolkit.dochub_survey.schema,
    },
  );

  return [collections, search, read, survey] as DynamicStructuredTool[];
}

export type { DochubDocumentRef };
