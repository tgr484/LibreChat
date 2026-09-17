import { logger } from '@librechat/data-schemas';
import { initializeModel, Providers } from '@librechat/agents';
import { Constants, EModelEndpoint } from 'librechat-data-provider';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type { ClientOptions } from '@librechat/agents';
import type { EndpointDbMethods, ServerRequest } from '~/types';
import type { DochubPhase, RunBudget } from './budget';
import type { DochubAgentSettings } from './types';
import { getProviderConfig } from '~/endpoints/config/providers';
import { resolveRequestTenantId } from '~/middleware/tenant';
import { resolveConfigHeaders } from '~/utils/headers';
import { getModelMaxTokens } from '~/utils/tokens';
import { omitTitleOptions } from '~/agents/client';
import { createSafeUser } from '~/utils/env';
import { stoppedError } from './budget';
import { DochubError } from './errors';

/** The agent that called the tool; its endpoint and model are the defaults. */
export interface DochubLlmAgent {
  endpoint?: string;
  provider?: string;
  model?: string;
  model_parameters?: { model?: string };
}

export interface DochubLlm {
  model: string;
  /** Context window when the model is known to LibreChat; used to split big chapters. */
  contextTokens?: number;
  /** `work` calls stop when the work phase ends; `reduce` calls run into the reserve. */
  invoke(prompt: string, budget: RunBudget, phase?: DochubPhase): Promise<string>;
}

/** A sub-agent answer is always plain text; some providers return content parts. */
export function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      const text = (part as { type?: string; text?: unknown } | null)?.text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

/**
 * Reasoning models leak their thinking into `content`; it must not reach a
 * summary. An unclosed `<think>` means the answer was cut off mid-thought, and
 * what is left is reasoning, not an answer.
 */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}

const CUT_OFF_REASONING = /<think>(?![\s\S]*<\/think>)/i;

/** Custom endpoints are the OpenAI-compatible gateways (vLLM, SGLang behind LiteLLM). */
const KNOWN_ENDPOINTS: ReadonlySet<string> = new Set(Object.values(EModelEndpoint));

type SubAgentOptions = ClientOptions & {
  maxTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  modelKwargs?: Record<string, unknown>;
  clientOptions?: object;
  configuration?: object;
};

/**
 * Resolves the model the sub-agent runs on: by default the endpoint and model
 * of the chat that called the tool, through the same provider resolution the
 * chat itself uses — so a custom endpoint (an internal LiteLLM gateway), its
 * keys, proxy headers and SSRF guards all apply unchanged.
 *
 * Mirrors the option sanitising of `activityLabels/host.ts`: primary-generation
 * options (streaming, thinking, output caps sized for the chat) are dropped and
 * replaced by the sub-agent's own cap.
 */
export async function resolveDochubLlm(params: {
  req: ServerRequest;
  agent: DochubLlmAgent | undefined;
  settings: DochubAgentSettings;
  db: EndpointDbMethods;
}): Promise<DochubLlm> {
  const { req, agent, settings, db } = params;
  const appConfig = req.config as AppConfig | undefined;
  const agentEndpoint = agent?.endpoint ?? agent?.provider ?? '';

  let endpoint = agentEndpoint;
  let providerConfig = getProviderConfig({ provider: agentEndpoint, appConfig });
  if (settings.endpoint != null && settings.endpoint !== agentEndpoint) {
    try {
      providerConfig = getProviderConfig({ provider: settings.endpoint, appConfig });
      endpoint = settings.endpoint;
    } catch (error) {
      logger.warn(
        `[dochub] unknown dochub.agent.endpoint "${settings.endpoint}", using "${agentEndpoint}"`,
        error,
      );
    }
  }

  const runModel = agent?.model_parameters?.model ?? agent?.model ?? '';
  const model =
    settings.model != null && settings.model !== Constants.CURRENT_MODEL
      ? settings.model
      : runModel;

  const options = await providerConfig.getOptions({
    req,
    endpoint,
    model_parameters: { model },
    db,
  });

  let provider = (options.provider ??
    providerConfig.overrideProvider ??
    agent?.provider) as Providers;
  if (endpoint === EModelEndpoint.azureOpenAI) {
    const instance = (options.llmConfig as { azureOpenAIApiInstanceName?: string } | undefined)
      ?.azureOpenAIApiInstanceName;
    provider = instance == null ? Providers.OPENAI : Providers.AZURE;
  }

  const raw = { ...(options.llmConfig ?? {}) } as SubAgentOptions;
  delete raw.maxTokens;
  if (raw.modelKwargs != null) {
    const {
      max_completion_tokens: _completion,
      max_output_tokens: _output,
      ...rest
    } = raw.modelKwargs;
    raw.modelKwargs = rest;
  }
  /** Kept by reference: it carries proxy headers and the SSRF-guarded fetch options. */
  const carrier = raw.clientOptions;
  const clientOptions = Object.fromEntries(
    Object.entries(raw).filter(([key]) => !omitTitleOptions.has(key)),
  ) as SubAgentOptions;
  if (carrier != null && clientOptions.clientOptions == null) {
    clientOptions.clientOptions = carrier;
  }

  const isGpt5Plus = /\bgpt-[5-9](?:\.\d+)?\b/i.test(model);
  const isOSeries = /\bo[1-9](?:[-.]|\b)/i.test(model);
  if (provider === Providers.GOOGLE || provider === Providers.VERTEXAI) {
    clientOptions.maxOutputTokens = settings.maxOutputTokens;
  } else if (isGpt5Plus) {
    clientOptions.modelKwargs = {
      ...(clientOptions.modelKwargs ?? {}),
      max_completion_tokens: settings.maxOutputTokens,
    };
  } else if (!isOSeries) {
    clientOptions.maxTokens = settings.maxOutputTokens;
  }
  if (!isGpt5Plus && !isOSeries) {
    clientOptions.temperature = settings.temperature;
  }
  if (!settings.thinking && !KNOWN_ENDPOINTS.has(endpoint)) {
    const kwargs = clientOptions.modelKwargs ?? {};
    const template = (kwargs.chat_template_kwargs ?? {}) as Record<string, unknown>;
    clientOptions.modelKwargs = {
      ...kwargs,
      chat_template_kwargs: { ...template, enable_thinking: false },
    };
  }
  if (options.configOptions) {
    clientOptions.configuration = options.configOptions;
  }

  const body = req.body as
    | { messageId?: string; conversationId?: string; parentMessageId?: string }
    | undefined;
  resolveConfigHeaders({
    llmConfig: clientOptions,
    user: createSafeUser(req.user as IUser | undefined),
    tenantId: resolveRequestTenantId(req),
    body: {
      messageId: body?.messageId,
      conversationId: body?.conversationId,
      parentMessageId: body?.parentMessageId,
    },
  });

  const chat = initializeModel({
    provider,
    clientOptions: { ...clientOptions, streaming: false, disableStreaming: true } as ClientOptions,
  }) as { invoke: (input: string, config?: object) => Promise<{ content?: unknown }> };

  return {
    model,
    contextTokens: getModelMaxTokens(
      model,
      endpoint as EModelEndpoint,
      options.endpointTokenConfig,
    ),
    invoke: async (prompt, budget, phase = 'work') => {
      const stop = phase === 'work' ? budget.workSignal : budget.signal;
      if (stop.aborted) {
        throw stoppedError(budget, `sub-agent ${phase} call`);
      }
      budget.chargeLlm(phase);
      const timeout = AbortSignal.timeout(budget.limits.llmCallTimeoutMs);
      let text: string;
      try {
        const response = await chat.invoke(prompt, { signal: AbortSignal.any([stop, timeout]) });
        text = extractText(response?.content);
      } catch (error) {
        if (stop.aborted) {
          throw stoppedError(budget, `sub-agent ${phase} call`);
        }
        if (timeout.aborted) {
          throw new DochubError({
            kind: 'timeout',
            message: `sub-agent ${phase} call → no answer in ${budget.limits.llmCallTimeoutMs} ms`,
            retryable: false,
          });
        }
        throw error;
      }
      const answer = stripReasoning(text);
      if (answer === '' && CUT_OFF_REASONING.test(text)) {
        throw new DochubError({
          kind: 'server',
          message: `sub-agent ${phase} call → answer cut off inside reasoning`,
          retryable: false,
        });
      }
      return answer;
    },
  };
}
