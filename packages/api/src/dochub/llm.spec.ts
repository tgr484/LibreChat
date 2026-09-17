import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AppConfig } from '@librechat/data-schemas';
import type { AddressInfo } from 'node:net';
import type { EndpointDbMethods, ServerRequest } from '~/types';
import type { DochubLimits } from './types';
import { createRunBudget } from './budget';
import { resolveDochubLlm } from './llm';

/**
 * A stand-in for the internal LiteLLM gateway: an OpenAI-compatible
 * `/chat/completions` that records what LibreChat sent. The provider
 * resolution, the client and the request are all real.
 */
let server: Server;
let baseURL: string;
let received: Array<Record<string, unknown>> = [];
let reply = 'ответ';
let delayMs = 0;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        path: req.url,
        authorization: req.headers.authorization,
        ...JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      });
      const respond = () => {
        if (res.destroyed) {
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            created: 0,
            model: 'qwen3.6-27B-flash',
            choices: [
              { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: reply } },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
      };
      setTimeout(respond, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received = [];
  reply = 'ответ';
  delayMs = 0;
});

const limits: DochubLimits = {
  wallClockMs: 60000,
  reduceReserveMs: 1000,
  llmCallTimeoutMs: 60000,
  maxHttpRequests: 10,
  maxLlmCalls: 2,
  maxChapters: 40,
  maxChapterChars: 30000,
  maxDocuments: 6,
  chapterConcurrency: 4,
  documentConcurrency: 3,
  extractionCharLimit: 1200,
  resultCharLimit: 6000,
};

const db: EndpointDbMethods = {
  getUserKey: async () => '',
  getUserKeyValues: async () => ({}),
};

const request = (): ServerRequest =>
  ({
    user: { id: 'user-1', provider: 'ldap', ldapId: 'ivanov' },
    body: { conversationId: 'conv-1' },
    config: {
      endpoints: {
        custom: [
          {
            name: 'RNT',
            apiKey: 'gateway-key',
            baseURL,
            models: { default: ['qwen3.6-27B-flash', 'qwen-small'] },
            tokenConfig: {
              'qwen3.6-27B-flash': { prompt: 0, completion: 0, context: 32000 },
            },
          },
        ],
      },
    } as unknown as AppConfig,
  }) as unknown as ServerRequest;

describe('resolveDochubLlm', () => {
  it('calls the chat endpoint and model with the sub-agent limits', async () => {
    const llm = await resolveDochubLlm({
      req: request(),
      agent: { provider: 'RNT', model: 'qwen3.6-27B-flash' },
      settings: { temperature: 0, maxOutputTokens: 900, thinking: true },
      db,
    });
    const budget = createRunBudget({ limits });

    await expect(llm.invoke('Вопрос', budget)).resolves.toBe('ответ');
    budget.dispose();

    expect(llm.model).toBe('qwen3.6-27B-flash');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      path: '/v1/chat/completions',
      authorization: 'Bearer gateway-key',
      model: 'qwen3.6-27B-flash',
      temperature: 0,
      max_tokens: 900,
    });
    expect(received[0].stream).not.toBe(true);
  });

  it('prefers the model the conversation actually runs on', async () => {
    const llm = await resolveDochubLlm({
      req: request(),
      agent: {
        provider: 'RNT',
        model: 'stale-model',
        model_parameters: { model: 'qwen3.6-27B-flash' },
      },
      settings: { temperature: 0, maxOutputTokens: 900, thinking: true },
      db,
    });
    expect(llm.model).toBe('qwen3.6-27B-flash');
  });

  it('uses a configured sub-agent model instead of the chat model', async () => {
    const llm = await resolveDochubLlm({
      req: request(),
      agent: { provider: 'RNT', model: 'qwen3.6-27B-flash' },
      settings: { model: 'qwen-small', temperature: 0.2, maxOutputTokens: 500, thinking: true },
      db,
    });
    const budget = createRunBudget({ limits });
    await llm.invoke('Вопрос', budget);
    budget.dispose();

    expect(received[0]).toMatchObject({ model: 'qwen-small', temperature: 0.2, max_tokens: 500 });
  });

  it('strips leaked reasoning from the answer', async () => {
    reply = '<think>сначала подумаю</think>\nЧистый ответ';
    const llm = await resolveDochubLlm({
      req: request(),
      agent: { provider: 'RNT', model: 'qwen3.6-27B-flash' },
      settings: { temperature: 0, maxOutputTokens: 900, thinking: true },
      db,
    });
    const budget = createRunBudget({ limits });

    await expect(llm.invoke('Вопрос', budget)).resolves.toBe('Чистый ответ');
    budget.dispose();
  });

  it('charges every call to the budget and refuses once it is spent', async () => {
    const llm = await resolveDochubLlm({
      req: request(),
      agent: { provider: 'RNT', model: 'qwen3.6-27B-flash' },
      settings: { temperature: 0, maxOutputTokens: 900, thinking: true },
      db,
    });
    const budget = createRunBudget({ limits });

    await llm.invoke('1', budget);
    await llm.invoke('2', budget);
    await expect(llm.invoke('3', budget)).rejects.toMatchObject({ kind: 'budget' });
    expect(received).toHaveLength(2);
    budget.dispose();
  });

  it('switches reasoning off on a custom endpoint unless configured', async () => {
    const quiet = await resolveDochubLlm({
      req: request(),
      agent: { provider: 'RNT', model: 'qwen3.6-27B-flash' },
      settings: { temperature: 0, maxOutputTokens: 900, thinking: false },
      db,
    });
    const thinking = await resolveDochubLlm({
      req: request(),
      agent: { provider: 'RNT', model: 'qwen3.6-27B-flash' },
      settings: { temperature: 0, maxOutputTokens: 900, thinking: true },
      db,
    });
    const budget = createRunBudget({ limits: { ...limits, maxLlmCalls: 5 } });

    await quiet.invoke('1', budget);
    await thinking.invoke('2', budget);
    budget.dispose();

    expect(received[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(received[1].chat_template_kwargs).toBeUndefined();
  });

  it('rejects an answer cut off inside its reasoning', async () => {
    reply = '<think>долго думаю и не успеваю';
    const llm = await resolveDochubLlm({
      req: request(),
      agent: { provider: 'RNT', model: 'qwen3.6-27B-flash' },
      settings: { temperature: 0, maxOutputTokens: 900, thinking: true },
      db,
    });
    const budget = createRunBudget({ limits });

    await expect(llm.invoke('Вопрос', budget)).rejects.toMatchObject({ kind: 'server' });
    budget.dispose();
  });

  describe('stopping a call', () => {
    const slowLlm = () =>
      resolveDochubLlm({
        req: request(),
        agent: { provider: 'RNT', model: 'qwen3.6-27B-flash' },
        settings: { temperature: 0, maxOutputTokens: 900, thinking: false },
        db,
      });

    /** The extraction in flight ends with the work phase; the reduce still runs. */
    it('stops a work call when the work phase ends and lets the reduce through', async () => {
      const llm = await slowLlm();
      const budget = createRunBudget({
        limits: { ...limits, maxLlmCalls: 5, wallClockMs: 3000, reduceReserveMs: 2800 },
      });

      delayMs = 1000;
      const startedAt = Date.now();
      await expect(llm.invoke('выписка', budget, 'work')).rejects.toMatchObject({
        kind: 'budget',
      });
      expect(Date.now() - startedAt).toBeLessThan(900);

      delayMs = 100;
      await expect(llm.invoke('сведение', budget, 'reduce')).resolves.toBe('ответ');
      await expect(llm.invoke('ещё выписка', budget, 'work')).rejects.toMatchObject({
        kind: 'budget',
      });
      budget.dispose();
    });

    it('gives up on one hung request without spending the whole call', async () => {
      const llm = await slowLlm();
      const budget = createRunBudget({ limits: { ...limits, llmCallTimeoutMs: 150 } });

      delayMs = 1000;
      await expect(llm.invoke('выписка', budget)).rejects.toMatchObject({ kind: 'timeout' });
      expect(budget.signal.aborted).toBe(false);
      budget.dispose();
    });

    it('reports a user stop as aborted', async () => {
      const llm = await slowLlm();
      const controller = new AbortController();
      const budget = createRunBudget({ limits, parentSignal: controller.signal });

      delayMs = 1000;
      const pending = llm.invoke('выписка', budget);
      setTimeout(() => controller.abort(), 50);
      await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
      budget.dispose();
    });
  });
});
