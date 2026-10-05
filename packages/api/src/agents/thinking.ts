import { logger } from '@librechat/data-schemas';
import type { TThinkingConfig } from 'librechat-data-provider';
import type { EndpointDbMethods, EndpointRuntimeContext } from '~/types';
import {
  extractText,
  stripReasoning,
  isCustomGateway,
  withEnableThinking,
  createAuxiliaryModel,
} from '~/endpoints/auxiliary';

export interface ThinkingDecision {
  enabled: boolean;
  source: 'classifier' | 'fallback';
}

/** Test seam: answers the classifier prompt; the server builds it from the config. */
export type ThinkingClassify = (prompt: string, signal: AbortSignal) => Promise<string>;

/** Room for a stray `<think>` wrapper around the one-word answer. */
const CLASSIFIER_MAX_OUTPUT_TOKENS = 32;

const DEFAULT_PROMPT = `Определи, нужно ли модели подробно рассуждать, прежде чем ответить на сообщение пользователя.

complex — задача требует нескольких шагов мысли: анализ, сравнение вариантов, расчёты и математика, логические задачи, написание или отладка кода, планирование, выводы по документам, вопросы, в которых легко ошибиться.
simple — всё остальное: приветствие, короткий фактический вопрос, перевод, перефразирование, простой текст по образцу, уточнение к предыдущему ответу.

Ответь одним словом: simple или complex.`;

/** One decision per chat turn, shared by every agent the turn initializes. */
const decisions = new WeakMap<object, Promise<ThinkingDecision>>();

/** `complex` → true, `simple` → false, anything else → undefined. */
export function parseClassifierAnswer(text: string): boolean | undefined {
  const answer = stripReasoning(text).trim().toLowerCase();
  if (/^[^a-zа-я]*complex\b/.test(answer)) {
    return true;
  }
  if (/^[^a-zа-я]*simple\b/.test(answer)) {
    return false;
  }
  return undefined;
}

export function buildClassifierPrompt(
  config: TThinkingConfig,
  text: string,
  attachments: number,
): string {
  const message = text.slice(0, config.classifier.maxInputChars);
  const files = attachments > 0 ? `\n\nК сообщению приложено файлов: ${attachments}.` : '';
  return `${config.classifier.prompt ?? DEFAULT_PROMPT}

Сообщение пользователя:
"""
${message}
"""${files}

Ответ (simple или complex):`;
}

async function classify(params: {
  config: TThinkingConfig;
  runtime: EndpointRuntimeContext;
  db: EndpointDbMethods;
  classify?: ThinkingClassify;
}): Promise<ThinkingDecision> {
  const { config, runtime } = params;
  const fallback: ThinkingDecision = { enabled: config.fallback, source: 'fallback' };
  const text = runtime.requestBody.text?.trim() ?? '';
  if (!text) {
    return fallback;
  }

  const startedAt = Date.now();
  const signal = AbortSignal.timeout(config.classifier.timeoutMs);
  const prompt = buildClassifierPrompt(config, text, runtime.requestBody.files?.length ?? 0);
  try {
    const answer = params.classify
      ? await params.classify(prompt, signal)
      : await invokeClassifier({ ...params, prompt, signal });
    const enabled = parseClassifierAnswer(answer);
    if (enabled == null) {
      logger.warn(`[thinking] unreadable classifier answer "${answer.slice(0, 40)}", fallback`);
      return fallback;
    }
    logger.info(
      `[thinking] ${enabled ? 'on' : 'off'} model=${config.classifier.model} ms=${Date.now() - startedAt}`,
    );
    return { enabled, source: 'classifier' };
  } catch (error) {
    const reason = signal.aborted ? 'timeout' : ((error as Error)?.message ?? 'error');
    logger.warn(`[thinking] classifier failed (${reason}), fallback`);
    return fallback;
  }
}

async function invokeClassifier(params: {
  config: TThinkingConfig;
  runtime: EndpointRuntimeContext;
  db: EndpointDbMethods;
  prompt: string;
  signal: AbortSignal;
}): Promise<string> {
  const { config, runtime, db } = params;
  const { chat } = await createAuxiliaryModel({
    runtime,
    endpoint: config.classifier.endpoint,
    model: config.classifier.model,
    maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
    temperature: 0,
    thinking: false,
    db,
  });
  const response = await chat.invoke(params.prompt, { signal: params.signal });
  return extractText(response?.content);
}

/**
 * Starts deciding whether this turn's model should reason, or returns
 * `undefined` when the classifier does not control this endpoint. Never
 * rejects: any failure resolves to the configured fallback. Called early so
 * the classifier call overlaps the rest of agent initialization.
 *
 * @param key The object one turn shares across its agents (the request).
 */
export function startThinkingDecision(params: {
  key: object;
  endpoint: string;
  runtime: EndpointRuntimeContext;
  db: EndpointDbMethods;
  classify?: ThinkingClassify;
}): Promise<ThinkingDecision> | undefined {
  const config = params.runtime.appConfig?.thinking;
  if (!config?.enabled || !config.endpoints.includes(params.endpoint)) {
    return undefined;
  }
  const existing = decisions.get(params.key);
  if (existing) {
    return existing;
  }
  const decision = classify({ ...params, config });
  decisions.set(params.key, decision);
  return decision;
}

/**
 * The generation config with the decision applied — a copy, since the
 * resolved config can be shared. Only custom gateways understand the flag.
 */
export function applyThinkingDecision<T extends { modelKwargs?: Record<string, unknown> }>(
  llmConfig: T,
  decision: ThinkingDecision | undefined,
  providerConfig: { customEndpointConfig?: unknown; overrideProvider?: string },
): T {
  if (decision == null || !isCustomGateway(providerConfig)) {
    return llmConfig;
  }
  return { ...llmConfig, modelKwargs: withEnableThinking(llmConfig.modelKwargs, decision.enabled) };
}
