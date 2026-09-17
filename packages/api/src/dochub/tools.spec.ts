import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { IUser } from '@librechat/data-schemas';
import type { AddressInfo } from 'node:net';
import type { ServerRequest } from '~/types';
import type { DochubLlm } from './llm';
import { toolDefinitions } from '~/tools/registry/definitions';
import { toolkitExpansion } from '~/tools/toolkits/mapping';
import { dochubToolkit } from '~/tools/toolkits/dochub';
import { createDochubTools, parsePages } from './tools';
import { resetDochubConfigCache } from './config';
import { NO_DATA } from './prompts';

const dir = mkdtempSync(join(tmpdir(), 'dochub-tools-'));
const keyPath = join(dir, 'key.pem');
writeFileSync(
  keyPath,
  generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string,
);

type Route = (body: string) => { status: number; body: unknown };

let server: Server;
let baseURL: string;
let routes: Record<string, Route> = {};
let requests: string[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const key = `${req.method} ${(req.url ?? '').split('?')[0]}`;
      requests.push(key);
      const route = routes[key];
      const reply = route
        ? route(Buffer.concat(chunks).toString('utf8'))
        : { status: 404, body: { detail: 'Not Found' } };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/integration/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetDochubConfigCache();
  requests = [];
  routes = {
    'GET /api/integration/v1/collections': () => ({
      status: 200,
      body: {
        my: [
          {
            id: 7,
            name: 'Нефтяное хозяйство 2018',
            description: 'Выпуски журнала',
            document_count: 42,
          },
          { id: 8, name: 'Нефтяное хозяйство 2019', description: null, document_count: 40 },
        ],
        shared_with_me: [],
        public: [
          {
            id: 19,
            name: 'Инструкции по бурению',
            description: null,
            document_count: 9,
            owner_username: 'petrov',
          },
        ],
      },
    }),
    'POST /api/integration/v1/collections/7/search': (body) => ({
      status: 200,
      body: {
        collection_id: 7,
        query: JSON.parse(body).query,
        degraded: true,
        hits: [
          {
            seq: 3,
            id: 103,
            title: 'Испытания турбодетандера',
            doc_type: 'article',
            category_name: null,
            summary_preview: 'выжимка',
            match_reason: 'похож по смыслу на запрос (72%)',
            score: 0.72,
            can_open: true,
            snippets: ['…испытания на стенде показали…'],
          },
          {
            seq: 11,
            id: 111,
            title: 'Закрытый отчёт',
            doc_type: 'report',
            category_name: null,
            summary_preview: 'выжимка',
            match_reason: 'похож по смыслу на выжимку (55%)',
            score: 0.55,
            can_open: false,
            snippets: [],
          },
        ],
      },
    }),
  };
});

const makeReq = (user: Partial<IUser>, dochub: object | undefined = undefined): ServerRequest =>
  ({
    user: { id: '65f0c3a1b2c3d4e5f6a7b8c9', provider: 'ldap', ldapId: 'ivanov', ...user },
    config: {
      dochub: dochub ?? {
        enabled: true,
        baseURL,
        keyId: 'test',
        privateKeyPath: keyPath,
        limits: { wallClockMs: 10000, reduceReserveMs: 1000 },
      },
    },
  }) as unknown as ServerRequest;

const stubLlm: DochubLlm = {
  model: 'stub',
  invoke: async (prompt, budget) => {
    budget.chargeLlm();
    if (prompt.includes('--- ВЫПИСКИ ---')) {
      return 'Турбодетандер испытан на стенде [№3, с. 12].';
    }
    return prompt.includes('турбодетандер') ? 'испытан на стенде (с. 12)' : NO_DATA;
  },
};

const toolByName = (req: ServerRequest, name: string) => {
  const found = createDochubTools({ req, resolveLlm: async () => stubLlm }).find(
    (candidate) => candidate.name === name,
  );
  if (!found) {
    throw new Error(`tool ${name} was not created`);
  }
  return found;
};

describe('createDochubTools', () => {
  /** The model sees the registry, the builder sees the cache, the run sees these. */
  it('creates exactly the tools the toolkit, the expansion and the registry declare', () => {
    const tools = createDochubTools({ req: makeReq({}) });
    const names = tools.map((candidate) => candidate.name);

    expect(names).toEqual([...toolkitExpansion.dochub]);
    for (const created of tools) {
      const declared = dochubToolkit[created.name as keyof typeof dochubToolkit];
      expect(created.description).toBe(declared.description);
      expect(toolDefinitions[created.name]).toMatchObject({
        name: declared.name,
        description: declared.description,
        schema: declared.schema,
        toolType: 'builtin',
      });
    }
  });

  it('creates nothing when the integration is not configured', () => {
    expect(createDochubTools({ req: makeReq({}, { enabled: false }) })).toEqual([]);
  });

  it('refuses users who did not sign in through LDAP, without calling DocHub', async () => {
    const tool = toolByName(makeReq({ provider: 'local' }), 'dochub_collections');

    await expect(tool.invoke({})).resolves.toContain('LDAP');
    expect(requests).toHaveLength(0);
  });

  it('refuses an LDAP login DocHub would reject, without calling DocHub', async () => {
    const tool = toolByName(makeReq({ ldapId: 'ivanov@corp.rn-t.ru' }), 'dochub_collections');

    await expect(tool.invoke({})).resolves.toContain('не сопоставлена');
    expect(requests).toHaveLength(0);
  });
});

describe('dochub_collections', () => {
  it('lists the collections by section', async () => {
    const result = await toolByName(makeReq({}), 'dochub_collections').invoke({});

    expect(result).toContain('Свои коллекции:');
    expect(result).toContain('«Нефтяное хозяйство 2018» (id 7, документов: 42) — Выпуски журнала');
    expect(result).toContain('Публичные:');
    expect(result).toContain('владелец: petrov');
    expect(result).not.toContain('Доступные по приглашению');
  });

  it('narrows the list by a filter', async () => {
    const result = await toolByName(makeReq({}), 'dochub_collections').invoke({
      filter: 'бурению',
    });

    expect(result).toContain('Инструкции по бурению');
    expect(result).not.toContain('Нефтяное');
  });
});

describe('dochub_search', () => {
  it('searches the collection the user named and flags closed documents', async () => {
    const result = await toolByName(makeReq({}), 'dochub_search').invoke({
      collection: 'нефтяное хозяйство 2018',
      query: 'турбодетандер',
    });

    expect(requests).toContain('POST /api/integration/v1/collections/7/search');
    expect(result).toContain('№3 «Испытания турбодетандера» (релевантность 0.72)');
    expect(result).toContain('Фрагмент: …испытания на стенде показали…');
    expect(result).toContain('№11 «Закрытый отчёт» (релевантность 0.55) — ПОЛНЫЙ ТЕКСТ НЕДОСТУПЕН');
    expect(result).toContain('поиск выполнен без разбора запроса');
  });

  it('asks which collection is meant instead of guessing', async () => {
    const result = await toolByName(makeReq({}), 'dochub_search').invoke({
      collection: 'нефтяное хозяйство',
      query: 'турбодетандер',
    });

    expect(result).toContain('подходит несколько коллекций');
    expect(result).toContain('Нефтяное хозяйство 2019');
    expect(requests.some((request) => request.includes('/search'))).toBe(false);
  });

  it('turns a DocHub refusal into an instruction for the model', async () => {
    routes['POST /api/integration/v1/collections/7/search'] = () => ({
      status: 403,
      body: { detail: 'forbidden' },
    });

    const result = await toolByName(makeReq({}), 'dochub_search').invoke({
      collection: '7',
      query: 'турбодетандер',
    });

    expect(result).toContain('нет доступа');
  });
});

describe('dochub_read', () => {
  beforeEach(() => {
    routes['GET /api/integration/v1/collections/7'] = () => ({
      status: 200,
      body: {
        id: 7,
        name: 'Нефтяное хозяйство 2018',
        description: null,
        owner_username: null,
        is_member: true,
        next_cursor: null,
        documents: [
          {
            seq: 3,
            id: 103,
            title: 'Испытания турбодетандера',
            doc_type: 'article',
            category_name: null,
            summary_preview: 'выжимка',
            can_open: true,
          },
        ],
      },
    });
    routes['GET /api/integration/v1/documents/103/outline'] = () => ({
      status: 200,
      body: {
        document_id: 103,
        title: 'Испытания турбодетандера',
        content_version: '2026-09-14 10:22:31|30000',
        chapters: [{ index: 0, heading: 'Введение', chars: 100, page_from: 12, page_to: 12 }],
      },
    });
    routes['GET /api/integration/v1/documents/103/content'] = () => ({
      status: 200,
      body: {
        document_id: 103,
        content_version: '2026-09-14 10:22:31|30000',
        chapter: 0,
        page_from: 12,
        page_to: 12,
        chars: 60,
        truncated: false,
        text: '<!-- page: 12 -->\nтурбодетандер испытан на стенде',
      },
    });
  });

  it('reads a document by its number and returns a condensed answer', async () => {
    const result = await toolByName(makeReq({}), 'dochub_read').invoke({
      collection: 'Нефтяное хозяйство 2018',
      document: '№3',
      question: 'Как испытывали турбодетандер?',
    });

    expect(result).toContain('№3 «Испытания турбодетандера» (коллекция «Нефтяное хозяйство 2018»)');
    expect(result).toContain('Прочитано частей: 1 из 1, с. 12–12.');
    expect(result).toContain('Турбодетандер испытан на стенде [№3, с. 12]');
    expect(requests).toContain('GET /api/integration/v1/documents/103/content');
  });

  /** DocHub's document routes are not scoped to a collection; the tool is. */
  it('refuses a document number the collection does not have', async () => {
    const result = await toolByName(makeReq({}), 'dochub_read').invoke({
      collection: '7',
      document: '42',
      question: 'Что там?',
    });

    expect(result).toContain('Такого документа в коллекции');
    expect(requests.some((request) => request.includes('/documents/'))).toBe(false);
  });

  it('says deep reading is unavailable when no model can be resolved', async () => {
    const tool = createDochubTools({
      req: makeReq({}),
      resolveLlm: async () => {
        throw new Error('no endpoint');
      },
    }).find((candidate) => candidate.name === 'dochub_read');

    const result = await tool?.invoke({ collection: '7', document: '3', question: 'Что там?' });
    expect(result).toContain('глубокое чтение сейчас недоступно');
    expect(requests.some((request) => request.includes('/documents/'))).toBe(false);
  });
});

describe('parsePages', () => {
  it('reads a page or a range, in either order', () => {
    expect(parsePages('12')).toEqual({ from: 12, to: undefined });
    expect(parsePages('12-30')).toEqual({ from: 12, to: 30 });
    expect(parsePages('30-12')).toEqual({ from: 12, to: 30 });
    expect(parsePages(undefined)).toBeUndefined();
    expect(parsePages('с. 12')).toBeUndefined();
  });
});

describe('dochub_survey', () => {
  beforeEach(() => {
    routes['GET /api/integration/v1/documents/103/outline'] = () => ({
      status: 200,
      body: {
        document_id: 103,
        title: 'Испытания турбодетандера',
        content_version: 'v1',
        chapters: [{ index: 0, heading: null, chars: 40, page_from: 5, page_to: 5 }],
      },
    });
    routes['GET /api/integration/v1/documents/103/content'] = () => ({
      status: 200,
      body: {
        document_id: 103,
        content_version: 'v1',
        chapter: 0,
        page_from: 5,
        page_to: 5,
        chars: 40,
        truncated: false,
        text: '<!-- page: 5 -->\nтурбодетандер',
      },
    });
    routes['GET /api/integration/v1/collections/7/documents/111/summary'] = () => ({
      status: 200,
      body: {
        id: 111,
        title: 'Закрытый отчёт',
        summary: 'турбодетандер упомянут',
        truncated: false,
        can_open: false,
      },
    });
  });

  it('surveys the collection with one search and never opens a closed text', async () => {
    const result = await toolByName(makeReq({}), 'dochub_survey').invoke({
      collection: 'Нефтяное хозяйство 2018',
      question: 'Что известно про турбодетандер?',
    });

    expect(requests.filter((request) => request.endsWith('/search'))).toHaveLength(1);
    expect(requests).not.toContain('GET /api/integration/v1/documents/111/outline');
    expect(requests).toContain('GET /api/integration/v1/collections/7/documents/111/summary');
    expect(result).toContain('Разобрано документов: 2.');
    expect(result).toContain('№11 «Закрытый отчёт» (только выжимка, полный текст недоступен)');
    expect(result).toContain('Поиск выполнен без разбора запроса');
  });
});
