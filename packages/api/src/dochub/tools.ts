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
import type { DochubExtractDepth } from './extract';
import type { DochubSurveyDepth } from './survey';
import type { EndpointDbMethods } from '~/types';
import type { DochubReadScope } from './reader';
import type { ServerRequest } from '~/types';
import type { DochubClient } from './client';
import type { RunBudget } from './budget';
import { createDochubCatalog, createDochubCatalogStore } from './catalog';
import { extractFromDocuments, formatExtractResult } from './extract';
import { formatSurveyResult, surveyCollection } from './survey';
import { formatReadResult, readDocument } from './reader';
import { DochubError, describeForModel } from './errors';
import { dochubToolkit } from '~/tools/toolkits/dochub';
import { isDochubConfigured } from './config';
import { openDochubSession } from './session';
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
const PINNED_UNAVAILABLE_MESSAGE =
  'Коллекция этого агента недоступна пользователю в DocHub: она стала приватной или у пользователя нет доступа. Сообщи об этом пользователю и не повторяй вызов.';
const NO_LLM_MESSAGE =
  'Не удалось подключить модель для чтения документов DocHub. Сообщи пользователю, что глубокое чтение сейчас недоступно, и опирайся на dochub_search.';
/** The schema allows 12; the config cannot raise it past that. */
const SURVEY_MAX_DOCUMENTS = 12;
const EXTRACT_MAX_DOCUMENTS = 40;

/** «№12», «12» → 12; anything else never matches a document. */
const parseSeq = (value: string): number => Number(value.replace(/[^\d]/g, '')) || -1;

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
  params: { req: ServerRequest; signal?: AbortSignal; toolName: string; pinned?: boolean },
  handler: (context: ToolContext) => Promise<string>,
): Promise<string> {
  const opened = openDochubSession(params);
  if (!opened.ok) {
    if (opened.reason === 'not_configured') {
      return 'Интеграция с DocHub не настроена на этом сервере. Сообщи об этом пользователю.';
    }
    logger.warn(`[dochub] ${params.toolName} refused: ${opened.reason}`);
    return opened.reason === 'not_ldap' ? NOT_LDAP_MESSAGE : NO_IDENTITY_MESSAGE;
  }

  const { client, budget, config, sub } = opened.session;
  const catalog = createDochubCatalog({ client, store: storeFor(params.req, sub) });
  const startedAt = Date.now();

  try {
    return await handler({ client, catalog, budget, config });
  } catch (error) {
    if (error instanceof DochubError) {
      const lostCollection = error.kind === 'collection_not_found' || error.kind === 'forbidden';
      return params.pinned === true && lostCollection
        ? PINNED_UNAVAILABLE_MESSAGE
        : describeForModel(error);
    }
    /** A programmer error must not take the whole chat run down with it. */
    logger.error(`[dochub] ${params.toolName} failed`, error);
    return 'Не удалось выполнить запрос к DocHub из-за внутренней ошибки. Сообщи об этом пользователю.';
  } finally {
    const spent = budget.spent();
    logger.info(
      `[dochub] tool=${params.toolName} sub=${sub} http=${spent.http} llm=${spent.llm} ms=${Date.now() - startedAt}`,
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

function formatList(
  collectionName: string,
  collectionId: number,
  refs: DochubDocumentRef[],
): string {
  if (refs.length === 0) {
    return `Коллекция «${collectionName}» (id ${collectionId}): документов нет.`;
  }
  const lines = [
    `Коллекция «${collectionName}» (id ${collectionId}). Всего документов: ${refs.length}.`,
  ];
  for (const ref of refs) {
    const closed = ref.canOpen ? '' : ' — полный текст недоступен, только выжимка';
    lines.push(`№${ref.seq} «${ref.title}»${closed}`);
  }
  return lines.join('\n');
}

function formatSearch(
  collectionName: string,
  collectionId: number,
  response: DochubSearchResponse,
  pinned: boolean,
): string {
  if (response.hits.length === 0) {
    const hint = pinned
      ? 'Попробуй другие формулировки; если ответа в коллекции нет, так и скажи пользователю.'
      : 'Попробуй другие формулировки или проверь коллекцию через dochub.';
    return `Коллекция «${collectionName}» (id ${collectionId}): по запросу ничего не найдено. ${hint}`;
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
  searchTool: string,
): string {
  const list = resolution.candidates
    .slice(0, 15)
    .map((ref) => `- №${ref.seq} «${ref.title}»`)
    .join('\n');
  if (resolution.reason === 'ambiguous') {
    return `Под это описание в коллекции «${collectionName}» подходит несколько документов. Уточни номер:\n${list}`;
  }
  const hint = list ? `\nДокументы коллекции (первые):\n${list}` : '';
  return `Такого документа в коллекции «${collectionName}» нет. Найди нужный через ${searchTool} и передай его номер (№).${hint}`;
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

interface SearchArgs {
  query: string;
  top_k?: number;
}

interface ReadArgs {
  document: string;
  question: string;
  scope?: DochubReadScope;
  pages?: string;
}

type LlmLoader = (settings: DochubAgentSettings) => Promise<DochubLlm | undefined>;

function createLlmLoader(params: CreateDochubToolsParams): LlmLoader {
  const { req, agent, db } = params;
  const resolveLlm =
    params.resolveLlm ??
    (async (settings: DochubAgentSettings): Promise<DochubLlm> => {
      if (!db) {
        throw new Error('DocHub sub-agent needs credential lookups (db)');
      }
      return resolveDochubLlm({ req, agent, settings, db });
    });

  return async (settings) => {
    try {
      return await resolveLlm(settings);
    } catch (error) {
      logger.error('[dochub] sub-agent model resolution failed', error);
      return undefined;
    }
  };
}

/** A pinned agent must never be told about the user's other collections. */
async function resolveFor(
  context: ToolContext,
  collection: string,
  pinned: boolean,
): Promise<{ ok: true; id: number; name: string } | { ok: false; message: string }> {
  const resolved = await context.catalog.resolveCollection(collection);
  if (resolved.ok) {
    return resolved;
  }
  return {
    ok: false,
    message: pinned ? PINNED_UNAVAILABLE_MESSAGE : describeCollectionMiss(resolved),
  };
}

async function runList(context: ToolContext, collection: string, pinned = false): Promise<string> {
  const resolved = await resolveFor(context, collection, pinned);
  if (!resolved.ok) {
    return resolved.message;
  }
  const refs = await context.catalog.indexDocuments(resolved.id);
  return formatList(resolved.name, resolved.id, refs);
}

async function runSearch(
  context: ToolContext,
  collection: string,
  { query, top_k: topK }: SearchArgs,
  pinned: boolean,
): Promise<string> {
  const resolved = await resolveFor(context, collection, pinned);
  if (!resolved.ok) {
    return resolved.message;
  }
  const settings = context.config.runtime.search;
  const limited = Math.min(topK ?? settings.defaultTopK, settings.maxTopK);
  const response = await context.client.search(resolved.id, query, limited);
  context.catalog.registerHits(resolved.id, response.hits);
  return formatSearch(resolved.name, resolved.id, response, pinned);
}

async function runRead(
  context: ToolContext,
  loadLlm: LlmLoader,
  collection: string,
  { document, question, scope, pages }: ReadArgs,
  searchTool: string,
  pinned = false,
): Promise<string> {
  const resolved = await resolveFor(context, collection, pinned);
  if (!resolved.ok) {
    return resolved.message;
  }
  const found = await context.catalog.resolveDocument(resolved.id, document);
  if (!found.ok) {
    return describeDocumentMiss(resolved.name, found, searchTool);
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
}

/**
 * The six tools the chat model sees. They are created only when the
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

  const list = tool(
    async ({ collection }: { collection: string }) =>
      withContext({ req, signal, toolName: 'dochub_list' }, (context) =>
        runList(context, collection),
      ),
    {
      name: dochubToolkit.dochub_list.name,
      description: dochubToolkit.dochub_list.description,
      schema: dochubToolkit.dochub_list.schema,
    },
  );

  const search = tool(
    async ({ collection, ...args }: SearchArgs & { collection: string }) =>
      withContext({ req, signal, toolName: 'dochub_search' }, (context) =>
        runSearch(context, collection, args, false),
      ),
    {
      name: dochubToolkit.dochub_search.name,
      description: dochubToolkit.dochub_search.description,
      schema: dochubToolkit.dochub_search.schema,
    },
  );

  const loadLlm = createLlmLoader(params);

  const read = tool(
    async ({ collection, ...args }: ReadArgs & { collection: string }) =>
      withContext({ req, signal, toolName: 'dochub_read' }, (context) =>
        runRead(context, loadLlm, collection, args, 'dochub_search'),
      ),
    {
      name: dochubToolkit.dochub_read.name,
      description: dochubToolkit.dochub_read.description,
      schema: dochubToolkit.dochub_read.schema,
    },
  );

  const extract = tool(
    async ({
      collection,
      fields,
      documents,
      depth,
    }: {
      collection: string;
      fields: string[];
      documents?: string[];
      depth?: DochubExtractDepth;
    }) =>
      withContext({ req, signal, toolName: 'dochub_extract' }, async (context) => {
        const resolved = await context.catalog.resolveCollection(collection);
        if (!resolved.ok) {
          return describeCollectionMiss(resolved);
        }
        const llm = await loadLlm(context.config.runtime.agent);
        if (!llm) {
          return NO_LLM_MESSAGE;
        }
        const all = await context.catalog.indexDocuments(resolved.id);
        const wanted = documents?.length ? new Set(documents.map(parseSeq)) : undefined;
        const refs = (wanted ? all.filter((ref) => wanted.has(ref.seq)) : all).slice(
          0,
          EXTRACT_MAX_DOCUMENTS,
        );
        if (refs.length === 0) {
          return `В коллекции «${resolved.name}» нет указанных документов. Сверься с dochub_list.`;
        }
        const { limits } = context.config.runtime;
        const result = await extractFromDocuments({
          collectionName: resolved.name,
          refs,
          fields,
          depth: depth ?? 'summary',
          client: context.client,
          llm,
          budget: context.budget,
          limits,
        });
        const beyond =
          (wanted ? all.filter((ref) => wanted.has(ref.seq)) : all).length - refs.length;
        const notes = [
          ...context.budget.notes(),
          ...(beyond > 0
            ? [
                `⚠ За один вызов берётся до ${EXTRACT_MAX_DOCUMENTS} документов; ещё ${beyond} — повтори вызов для них.`,
              ]
            : []),
        ];
        return formatExtractResult(result, notes, limits.resultCharLimit);
      }),
    {
      name: dochubToolkit.dochub_extract.name,
      description: dochubToolkit.dochub_extract.description,
      schema: dochubToolkit.dochub_extract.schema,
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

  return [collections, list, search, read, extract, survey] as DynamicStructuredTool[];
}

const UNPINNED_MESSAGE =
  'Этот агент DocHub не привязан к коллекции. Сообщи пользователю, что агента нужно пересохранить в разделе «Агенты DocHub», и не повторяй вызов.';

/**
 * The tools of a DocHub agent: the collection is the agent's, never the
 * model's. Access is still checked by DocHub as the chatting user, and the
 * id is resolved only within that user's listing. Without a pin the tools
 * refuse rather than fall back to an unscoped search.
 */
export function createDochubAgentTools(params: CreateDochubToolsParams): DynamicStructuredTool[] {
  const { req, signal, agent } = params;
  if (!isDochubConfigured(req.config)) {
    logger.warn('[dochub] agent tools requested while the integration is not configured');
    return [];
  }

  const collectionId = agent?.dochub?.collection_id;
  const pinned = async (
    toolName: string,
    handler: (context: ToolContext, collection: string) => Promise<string>,
  ): Promise<string> => {
    if (collectionId == null) {
      logger.warn(`[dochub] ${toolName} refused: agent has no pinned collection`);
      return UNPINNED_MESSAGE;
    }
    return withContext({ req, signal, toolName, pinned: true }, (context) =>
      handler(context, String(collectionId)),
    );
  };
  const loadLlm = createLlmLoader(params);
  const { dochub_agent_list, dochub_agent_search, dochub_agent_read } = dochubToolkit;

  const list = tool(
    async () =>
      pinned(dochub_agent_list.name, (context, collection) => runList(context, collection, true)),
    dochub_agent_list,
  );

  const search = tool(
    async (args: SearchArgs) =>
      pinned(dochub_agent_search.name, (context, collection) =>
        runSearch(context, collection, args, true),
      ),
    dochub_agent_search,
  );

  const read = tool(
    async (args: ReadArgs) =>
      pinned(dochub_agent_read.name, (context, collection) =>
        runRead(context, loadLlm, collection, args, dochub_agent_search.name, true),
      ),
    dochub_agent_read,
  );

  return [list, search, read] as DynamicStructuredTool[];
}

export type { DochubDocumentRef };
