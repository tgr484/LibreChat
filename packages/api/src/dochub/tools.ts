import { logger } from '@librechat/data-schemas';
import { tool } from '@librechat/agents/langchain/tools';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { DochubCollectionSummary, DochubDocumentRef, DochubSearchResponse } from './types';
import type { DochubCatalog, DochubCatalogStore, DochubCollectionResolution } from './catalog';
import type { DochubResolvedConfig } from './config';
import type { ServerRequest } from '~/types';
import type { DochubClient } from './client';
import type { RunBudget } from './budget';
import { createDochubCatalog, createDochubCatalogStore } from './catalog';
import { isDochubConfigured, resolveDochubConfig } from './config';
import { DochubError, describeForModel } from './errors';
import { dochubToolkit } from '~/tools/toolkits/dochub';
import { resolveDochubSubject } from './token';
import { createDochubClient } from './client';
import { createRunBudget } from './budget';

/** One catalog per chat turn: several tool calls must not re-list the collections. */
const CATALOG_STORE = Symbol.for('librechat.dochub.catalog');

const NOT_LDAP_MESSAGE =
  'Интеграция с DocHub доступна только пользователям, вошедшим через корпоративную учётную запись (LDAP). Сообщи об этом пользователю и не повторяй вызов.';
const NO_IDENTITY_MESSAGE =
  'Учётная запись пользователя не сопоставлена с логином DocHub — нужен администратор. Сообщи об этом пользователю и не повторяй вызов.';
const NOT_IMPLEMENTED_MESSAGE =
  'Этот инструмент ещё не включён в текущей сборке. Используй dochub_search и расскажи пользователю, что глубокое чтение документов пока недоступно.';

interface ToolContext {
  client: DochubClient;
  catalog: DochubCatalog;
  budget: RunBudget;
  config: DochubResolvedConfig;
}

function storeFor(req: ServerRequest): DochubCatalogStore {
  const holder = req as unknown as Record<symbol, DochubCatalogStore | undefined>;
  const existing = holder[CATALOG_STORE];
  if (existing) {
    return existing;
  }
  const created = createDochubCatalogStore();
  holder[CATALOG_STORE] = created;
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
  const catalog = createDochubCatalog({ client, store: storeFor(params.req) });
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
      ? `Коллекций с «${filter}» в названии нет. Покажи пользователю полный список, вызвав dochub_collections без фильтра.`
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
    return `Коллекция «${collectionName}» (id ${collectionId}): по запросу ничего не найдено. Попробуй другие формулировки или проверь коллекцию через dochub_collections.`;
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
}

/**
 * The four tools the chat model sees. They are created only when the
 * integration is configured — `loadAndFormatTools` keeps them out of the tool
 * cache in that case, and this is the second line of defence for an agent that
 * still lists them.
 */
export function createDochubTools(params: CreateDochubToolsParams): DynamicStructuredTool[] {
  const { req, signal } = params;
  if (!isDochubConfigured(req.config)) {
    logger.warn('[dochub] tools requested while the integration is not configured');
    return [];
  }

  const collections = tool(
    async ({ filter }: { filter?: string }) =>
      withContext({ req, signal, toolName: 'dochub_collections' }, async ({ catalog }) => {
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
      name: dochubToolkit.dochub_collections.name,
      description: dochubToolkit.dochub_collections.description,
      schema: dochubToolkit.dochub_collections.schema,
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

  const read = tool(async () => NOT_IMPLEMENTED_MESSAGE, {
    name: dochubToolkit.dochub_read.name,
    description: dochubToolkit.dochub_read.description,
    schema: dochubToolkit.dochub_read.schema,
  });

  const survey = tool(async () => NOT_IMPLEMENTED_MESSAGE, {
    name: dochubToolkit.dochub_survey.name,
    description: dochubToolkit.dochub_survey.description,
    schema: dochubToolkit.dochub_survey.schema,
  });

  return [collections, search, read, survey] as DynamicStructuredTool[];
}

export type { DochubDocumentRef };
