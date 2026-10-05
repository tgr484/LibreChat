import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type { TThinkingConfig } from 'librechat-data-provider';
import type { AddressInfo } from 'node:net';
import type { EndpointDbMethods, EndpointRuntimeContext } from '~/types';
import {
  applyThinkingDecision,
  buildClassifierPrompt,
  parseClassifierAnswer,
  startThinkingDecision,
} from './thinking';
import { getProviderConfig } from '~/endpoints/config/providers';

/**
 * A stand-in for the LiteLLM gateway: an OpenAI-compatible `/chat/completions`
 * that records what LibreChat sent. Provider resolution, client and request
 * are real — this is what proves the flag reaches the proxy.
 */
let server: Server;
let baseURL: string;
let received: Array<Record<string, unknown>> = [];
let reply = 'complex';
let delayMs = 0;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        userId: req.headers['user-id'],
        ...JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      });
      setTimeout(() => {
        if (res.destroyed) {
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            created: 0,
            model: 'qwen-flash',
            choices: [
              { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: reply } },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          }),
        );
      }, delayMs);
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
  reply = 'complex';
  delayMs = 0;
});

const db: EndpointDbMethods = {
  getUserKey: async () => '',
  getUserKeyValues: async () => ({}),
};

const thinking = (overrides: Partial<TThinkingConfig> = {}): TThinkingConfig => ({
  enabled: true,
  endpoints: ['RNT'],
  fallback: false,
  classifier: { endpoint: 'RNT', model: 'qwen-flash', timeoutMs: 2000, maxInputChars: 4000 },
  ...overrides,
});

const appConfig = (config: TThinkingConfig | undefined = thinking()): AppConfig =>
  ({
    thinking: config,
    endpoints: {
      custom: [
        {
          name: 'RNT',
          apiKey: 'gateway-key',
          baseURL,
          headers: { 'user-id': '{{LIBRECHAT_USER_LDAPID}}' },
          addParams: { chat_template_kwargs: { enable_thinking: false, keep: 1 } },
          models: { default: ['Qwen-3.8-27B', 'qwen-flash'] },
        },
      ],
    },
  }) as unknown as AppConfig;

const runtime = (
  text: string | undefined,
  config?: TThinkingConfig,
  files?: Array<{ file_id?: string }>,
): EndpointRuntimeContext => ({
  appConfig: appConfig(config),
  user: { id: 'user-1', provider: 'ldap', ldapId: 'ivanov' } as unknown as IUser,
  requestBody: { text, files, conversationId: 'conv-1' },
});

const decide = (context: EndpointRuntimeContext, endpoint = 'RNT', key: object = {}) =>
  startThinkingDecision({ key, endpoint, runtime: context, db });

describe('parseClassifierAnswer', () => {
  it('reads the one-word answer, also behind reasoning or punctuation', () => {
    expect(parseClassifierAnswer('complex')).toBe(true);
    expect(parseClassifierAnswer('  Simple.')).toBe(false);
    expect(parseClassifierAnswer('<think>хм</think>\n**complex**')).toBe(true);
    expect(parseClassifierAnswer('не знаю')).toBeUndefined();
    expect(parseClassifierAnswer('simpler than it looks')).toBeUndefined();
  });
});

describe('buildClassifierPrompt', () => {
  it('cuts long messages and mentions attachments', () => {
    const prompt = buildClassifierPrompt(
      thinking({ classifier: { ...thinking().classifier, maxInputChars: 5 } }),
      'абвгдеёжз',
      2,
    );
    expect(prompt).toContain('"""\nабвгд\n"""');
    expect(prompt).not.toContain('абвгде');
    expect(prompt).toContain('приложено файлов: 2');
  });

  it('uses the configured instruction instead of the built-in one', () => {
    const prompt = buildClassifierPrompt(
      thinking({ classifier: { ...thinking().classifier, prompt: 'СВОЯ ИНСТРУКЦИЯ' } }),
      'вопрос',
      0,
    );
    expect(prompt.startsWith('СВОЯ ИНСТРУКЦИЯ')).toBe(true);
  });
});

describe('startThinkingDecision', () => {
  it('stays out of endpoints it does not control', async () => {
    await expect(decide(runtime('вопрос', undefined), 'RNT')).resolves.toBeDefined();
    expect(decide(runtime('вопрос'), 'openAI')).toBeUndefined();
    expect(decide(runtime('вопрос', thinking({ enabled: false })))).toBeUndefined();
    expect(
      startThinkingDecision({
        key: {},
        endpoint: 'RNT',
        runtime: { ...runtime('вопрос'), appConfig: {} as AppConfig },
        db,
      }),
    ).toBeUndefined();
  });

  it('asks the classifier model with reasoning off and the proxy headers', async () => {
    await expect(decide(runtime('Сравни три архитектуры и оцени риски'))).resolves.toEqual({
      enabled: true,
      source: 'classifier',
    });

    expect(received).toHaveLength(1);
    const [call] = received;
    expect(call).toMatchObject({
      model: 'qwen-flash',
      temperature: 0,
      max_tokens: 32,
      userId: 'ivanov',
    });
    expect(call.chat_template_kwargs).toEqual({ enable_thinking: false, keep: 1 });
    expect(JSON.stringify(call.messages)).toContain('Сравни три архитектуры');
  });

  it('turns reasoning off for a simple message', async () => {
    reply = 'simple';
    await expect(decide(runtime('Привет!'))).resolves.toEqual({
      enabled: false,
      source: 'classifier',
    });
  });

  it('decides once per turn for every agent of it', async () => {
    const key = {};
    const context = runtime('вопрос');
    const [first, second] = await Promise.all([
      decide(context, 'RNT', key),
      decide(context, 'RNT', key),
    ]);
    expect(first).toEqual(second);
    expect(received).toHaveLength(1);
  });

  it('falls back without a call when the turn has no text', async () => {
    await expect(decide(runtime('   ', thinking({ fallback: true })))).resolves.toEqual({
      enabled: true,
      source: 'fallback',
    });
    expect(received).toHaveLength(0);
  });

  it('falls back on an unreadable answer', async () => {
    reply = 'возможно';
    await expect(decide(runtime('вопрос'))).resolves.toEqual({
      enabled: false,
      source: 'fallback',
    });
  });

  it('falls back when the classifier is too slow', async () => {
    delayMs = 500;
    const config = thinking({ classifier: { ...thinking().classifier, timeoutMs: 50 } });
    await expect(decide(runtime('вопрос', config))).resolves.toEqual({
      enabled: false,
      source: 'fallback',
    });
  });

  it('falls back when the classifier endpoint does not exist', async () => {
    const config = thinking({ classifier: { ...thinking().classifier, endpoint: 'nope' } });
    await expect(decide(runtime('вопрос', config))).resolves.toEqual({
      enabled: false,
      source: 'fallback',
    });
  });
});

describe('applyThinkingDecision', () => {
  it('overrides the addParams baseline on a copy of the main generation config', async () => {
    const providerConfig = getProviderConfig({ provider: 'RNT', appConfig: appConfig() });
    const options = await providerConfig.getOptions({
      runtime: runtime('вопрос'),
      endpoint: 'RNT',
      model_parameters: { model: 'Qwen-3.8-27B' },
      db,
    });
    const llmConfig = options.llmConfig as { modelKwargs?: Record<string, unknown> };
    const before = JSON.stringify(llmConfig.modelKwargs);

    const applied = applyThinkingDecision(
      llmConfig,
      { enabled: true, source: 'classifier' },
      providerConfig,
    );

    expect(applied.modelKwargs?.chat_template_kwargs).toEqual({ enable_thinking: true, keep: 1 });
    expect(JSON.stringify(llmConfig.modelKwargs)).toBe(before);
  });

  it('leaves the config alone without a decision or on a non-gateway endpoint', () => {
    const llmConfig = { modelKwargs: { a: 1 } };
    const decision = { enabled: true, source: 'classifier' as const };
    expect(
      applyThinkingDecision(llmConfig, undefined, {
        customEndpointConfig: {},
        overrideProvider: 'openAI',
      }),
    ).toBe(llmConfig);
    expect(applyThinkingDecision(llmConfig, decision, { overrideProvider: 'openAI' })).toBe(
      llmConfig,
    );
  });
});
