import jwt from 'jsonwebtoken';
import { createServer } from 'node:http';
import { logger } from '@librechat/data-schemas';
import { generateKeyPairSync } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DochubLimits, DochubRuntimeConfig } from './types';
import { createDochubClient } from './client';
import { createRunBudget } from './budget';
import { DochubError } from './errors';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

interface RecordedRequest {
  method: string;
  url: string;
  authorization?: string;
  at: number;
  body: string;
}

interface Programmed {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

let server: Server;
let baseURL: string;
let recorded: RecordedRequest[] = [];
let queue: Programmed[] = [];
let fallback: Programmed = { status: 200, body: {} };

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      recorded.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        at: Date.now(),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const next = queue.shift() ?? fallback;
      res.writeHead(next.status, { 'content-type': 'application/json', ...(next.headers ?? {}) });
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  recorded = [];
  queue = [];
  fallback = { status: 200, body: {} };
});

const limits: DochubLimits = {
  wallClockMs: 600000,
  reduceReserveMs: 45000,
  llmCallTimeoutMs: 60000,
  maxHttpRequests: 150,
  maxLlmCalls: 80,
  maxChapters: 40,
  maxChapterChars: 30000,
  maxDocuments: 6,
  chapterConcurrency: 4,
  documentConcurrency: 3,
  extractionCharLimit: 1200,
  resultCharLimit: 6000,
};

const runtime = (overrides: Partial<DochubRuntimeConfig> = {}): DochubRuntimeConfig => ({
  baseURL,
  issuer: 'librechat',
  audience: 'dochub-integration',
  keyId: '2026-09',
  tokenTtlSeconds: 60,
  requestTimeoutMs: 2000,
  limits,
  agent: { temperature: 0, maxOutputTokens: 900, thinking: false },
  search: { defaultTopK: 8, maxTopK: 20, slotRetries: 2, slotRetryDelayMs: 10 },
  ...overrides,
});

const waited: number[] = [];

const makeClient = (config: DochubRuntimeConfig = runtime()) => {
  const budget = createRunBudget({ limits: config.limits });
  const client = createDochubClient({
    config,
    key: privateKey,
    subject: { sub: 'ivanov', lcUid: 'abc123' },
    budget,
    wait: async (ms) => {
      waited.push(ms);
    },
  });
  return { client, budget };
};

const claimsOf = (index: number) => {
  const token = recorded[index].authorization?.replace('Bearer ', '') ?? '';
  return jwt.verify(token, publicKey, {
    algorithms: ['ES256'],
    issuer: 'librechat',
    audience: 'dochub-integration',
  }) as jwt.JwtPayload;
};

describe('createDochubClient — routes', () => {
  it('signs every request with a token DocHub can verify', async () => {
    fallback = { status: 200, body: { my: [], shared_with_me: [], public: [] } };
    const { client } = makeClient();

    await expect(client.listCollections()).resolves.toEqual({
      my: [],
      shared_with_me: [],
      public: [],
    });
    expect(recorded[0].url).toBe('/collections');
    expect(claimsOf(0).sub).toBe('ivanov');
  });

  it('sends the paging parameters of a collection page', async () => {
    fallback = { status: 200, body: { documents: [], next_cursor: null } };
    const { client } = makeClient();

    await client.getCollectionPage(7, { limit: 50, cursor: 'WzNd' });
    expect(recorded[0].url).toBe('/collections/7?limit=50&cursor=WzNd');
  });

  it('posts the search body DocHub expects', async () => {
    fallback = { status: 200, body: { hits: [], degraded: false } };
    const { client } = makeClient();

    await client.search(7, 'испытания турбодетандера', 8);
    expect(recorded[0].method).toBe('POST');
    expect(JSON.parse(recorded[0].body)).toEqual({
      query: 'испытания турбодетандера',
      top_k: 8,
    });
  });

  it('reads a chapter and url-encodes the opaque content version', async () => {
    fallback = { status: 200, body: { text: '', chars: 0 } };
    const { client } = makeClient();

    await client.getContent(101, { chapter: 0 }, '2026-09-14 10:22:31|30000');
    const [path, query] = recorded[0].url.split('?');
    expect(path).toBe('/documents/101/content');
    const parsed = new URLSearchParams(query);
    expect(parsed.get('chapter')).toBe('0');
    expect(parsed.get('version')).toBe('2026-09-14 10:22:31|30000');
    expect(parsed.get('page_from')).toBeNull();
  });

  it('reads a page range without a chapter', async () => {
    fallback = { status: 200, body: { text: '', chars: 0 } };
    const { client } = makeClient();

    await client.getContent(101, { pageFrom: 12, pageTo: 30 });
    const parsed = new URLSearchParams(recorded[0].url.split('?')[1]);
    expect(parsed.get('page_from')).toBe('12');
    expect(parsed.get('page_to')).toBe('30');
    expect(parsed.get('chapter')).toBeNull();
  });
});

describe('createDochubClient — failures', () => {
  it('re-signs once after a 401 and then stops the whole run', async () => {
    queue = [
      { status: 401, body: { detail: 'invalid_token' } },
      { status: 401, body: { detail: 'invalid_token' } },
    ];
    const { client } = makeClient();

    await expect(client.listCollections()).rejects.toMatchObject({ kind: 'auth' });
    expect(recorded).toHaveLength(2);
    /** The retry must carry a different jti — a repeat is a 401 by design. */
    expect(claimsOf(0).jti).not.toBe(claimsOf(1).jti);

    await expect(client.getOutline(1)).rejects.toMatchObject({ kind: 'auth' });
    expect(recorded).toHaveLength(2);
  });

  it('retries a busy ask slot only for search, and never in parallel', async () => {
    queue = [
      { status: 429, body: { detail: 'ask_slot_busy' } },
      { status: 429, body: { detail: 'ask_slot_busy' } },
      { status: 200, body: { hits: [], degraded: false } },
    ];
    const { client } = makeClient();

    await expect(client.search(7, 'ГРП', 8)).resolves.toEqual({ hits: [], degraded: false });
    expect(recorded).toHaveLength(3);
    expect(recorded[0].at).toBeLessThanOrEqual(recorded[1].at);
  });

  it('gives up on a busy ask slot after the configured attempts', async () => {
    fallback = { status: 429, body: { detail: 'ask_slot_busy' } };
    const { client } = makeClient();

    await expect(client.search(7, 'ГРП', 8)).rejects.toMatchObject({ kind: 'ask_slot_busy' });
    expect(recorded).toHaveLength(3);
  });

  it('does not treat a busy ask slot as retryable outside search', async () => {
    fallback = { status: 429, body: { detail: 'ask_slot_busy' } };
    const { client } = makeClient();

    await expect(client.getOutline(101)).rejects.toMatchObject({ kind: 'ask_slot_busy' });
    expect(recorded).toHaveLength(1);
  });

  it('honours Retry-After when rate limited', async () => {
    waited.length = 0;
    queue = [
      { status: 429, body: { detail: 'rate_limited' }, headers: { 'retry-after': '7' } },
      { status: 200, body: { my: [], shared_with_me: [], public: [] } },
    ];
    const { client } = makeClient();

    await client.listCollections();
    expect(waited).toContain(7000);
  });

  it.each([
    ['403 forbidden', 403, 'forbidden'],
    ['404 not_found', 404, 'not_found'],
    ['409 version_mismatch', 409, 'version_mismatch'],
    ['422 bad parameters', 422, 'chapter out of range'],
    ['503 integration_misconfigured', 503, 'integration_misconfigured'],
  ])('never retries %s', async (_label, status, detail) => {
    fallback = { status, body: { detail } };
    const { client } = makeClient();

    await expect(client.getOutline(101)).rejects.toBeInstanceOf(DochubError);
    expect(recorded).toHaveLength(1);
  });

  it('stops when the HTTP budget of one tool call is spent', async () => {
    fallback = { status: 200, body: {} };
    const config = runtime({ limits: { ...limits, maxHttpRequests: 2 } });
    const { client, budget } = makeClient(config);

    await client.getOutline(1);
    await client.getOutline(2);
    await expect(client.getOutline(3)).rejects.toMatchObject({ kind: 'budget' });
    expect(recorded).toHaveLength(2);
    expect(budget.notes().join(' ')).toContain('лимит обращений');
  });

  /** The parent signal is the user pressing stop; it must reach the socket. */
  it('stops immediately when the run is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createDochubClient({
      config: runtime(),
      key: privateKey,
      subject: { sub: 'ivanov' },
      budget: createRunBudget({ limits, parentSignal: controller.signal }),
    });

    await expect(client.listCollections()).rejects.toMatchObject({ kind: 'aborted' });
    expect(recorded).toHaveLength(0);
  });

  /** Running out of time is a partial answer for the callers, not a user stop. */
  it('reports the call deadline as a budget stop without retrying', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const budget = createRunBudget({ limits: { ...limits, wallClockMs: 1000 } });
    jest.advanceTimersByTime(1001);
    jest.useRealTimers();
    const pauses: number[] = [];
    const client = createDochubClient({
      config: runtime(),
      key: privateKey,
      subject: { sub: 'ivanov' },
      budget,
      wait: async (ms) => {
        pauses.push(ms);
      },
    });

    await expect(client.listCollections()).rejects.toMatchObject({ kind: 'budget' });
    expect(pauses).toEqual([]);
    budget.dispose();
  });
});

describe('createDochubClient — audit log', () => {
  it('records the call without the token, the query or the document text', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    fallback = { status: 200, body: { hits: [], degraded: false } };
    const { client } = makeClient();

    await client.search(7, 'секретная формулировка запроса', 8);

    const line = info.mock.calls
      .map((call) => String(call[0]))
      .find((call) => call.includes('[dochub]'));
    expect(line).toContain('sub=ivanov');
    expect(line).toContain('route=/collections/{id}/search');
    expect(line).toContain('status=200');
    expect(line).not.toContain('секретная');
    expect(line).not.toContain('Bearer');
    expect(line).not.toContain(recorded[0].authorization?.slice(-20) ?? 'token');
    info.mockRestore();
  });
});
