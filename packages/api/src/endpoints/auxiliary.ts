import { EModelEndpoint } from 'librechat-data-provider';
import { initializeModel, Providers } from '@librechat/agents';
import type { ClientOptions } from '@librechat/agents';
import type { EndpointDbMethods, EndpointRuntimeContext } from '~/types';
import { resolveConfigHeaders } from '~/utils/headers';
import { getModelMaxTokens } from '~/utils/tokens';
import { omitTitleOptions } from '~/agents/client';
import { getProviderConfig } from '~/endpoints';
import { createSafeUser } from '~/utils/env';

type AuxiliaryOptions = ClientOptions & {
  maxTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  modelKwargs?: Record<string, unknown>;
  clientOptions?: object;
  configuration?: object;
};

/** A side-call answer is always plain text; some providers return content parts. */
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

/** Non-streamed chat model for a side call; `invoke` takes a plain prompt. */
export interface AuxiliaryChat {
  invoke: (input: string, config?: { signal?: AbortSignal }) => Promise<{ content?: unknown }>;
}

export interface AuxiliaryModel {
  model: string;
  chat: AuxiliaryChat;
  /** Context window when the model is known to LibreChat. */
  contextTokens?: number;
}

/**
 * A `librechat.yaml` custom endpoint served through the OpenAI client — the
 * vLLM/SGLang gateways that understand `chat_template_kwargs`.
 */
export function isCustomGateway(providerConfig: {
  customEndpointConfig?: unknown;
  overrideProvider?: string;
}): boolean {
  return (
    providerConfig.customEndpointConfig != null &&
    providerConfig.overrideProvider === Providers.OPENAI
  );
}

/** Copies `modelKwargs` with `chat_template_kwargs.enable_thinking` set, never mutating the input. */
export function withEnableThinking(
  modelKwargs: Record<string, unknown> | undefined,
  enabled: boolean,
): Record<string, unknown> {
  const kwargs = modelKwargs ?? {};
  const template = (kwargs.chat_template_kwargs ?? {}) as Record<string, unknown>;
  return { ...kwargs, chat_template_kwargs: { ...template, enable_thinking: enabled } };
}

/**
 * Builds a model for a side call (a sub-agent, a classifier) on an endpoint of
 * this deployment, through the same provider resolution the chat uses — so a
 * custom endpoint's keys, proxy headers and SSRF guards apply unchanged.
 *
 * Primary-generation options (streaming, thinking, output caps sized for the
 * chat) are dropped and replaced by the call's own cap; `thinking: false`
 * switches reasoning off on custom gateways.
 */
export async function createAuxiliaryModel(params: {
  runtime: EndpointRuntimeContext;
  endpoint: string;
  model: string;
  maxOutputTokens: number;
  temperature?: number;
  thinking: boolean;
  db: EndpointDbMethods;
  /** Provider to fall back to when the endpoint config does not name one. */
  fallbackProvider?: string;
  tenantId?: string;
}): Promise<AuxiliaryModel> {
  const { runtime, endpoint, model, maxOutputTokens, db } = params;
  const providerConfig = getProviderConfig({ provider: endpoint, appConfig: runtime.appConfig });
  const options = await providerConfig.getOptions({
    runtime,
    endpoint,
    model_parameters: { model },
    db,
  });

  let provider = (options.provider ??
    providerConfig.overrideProvider ??
    params.fallbackProvider) as Providers;
  if (endpoint === EModelEndpoint.azureOpenAI) {
    const instance = (options.llmConfig as { azureOpenAIApiInstanceName?: string } | undefined)
      ?.azureOpenAIApiInstanceName;
    provider = instance == null ? Providers.OPENAI : Providers.AZURE;
  }

  const raw = { ...(options.llmConfig ?? {}) } as AuxiliaryOptions;
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
  ) as AuxiliaryOptions;
  if (carrier != null && clientOptions.clientOptions == null) {
    clientOptions.clientOptions = carrier;
  }

  const isGpt5Plus = /\bgpt-[5-9](?:\.\d+)?\b/i.test(model);
  const isOSeries = /\bo[1-9](?:[-.]|\b)/i.test(model);
  if (provider === Providers.GOOGLE || provider === Providers.VERTEXAI) {
    clientOptions.maxOutputTokens = maxOutputTokens;
  } else if (isGpt5Plus) {
    clientOptions.modelKwargs = {
      ...(clientOptions.modelKwargs ?? {}),
      max_completion_tokens: maxOutputTokens,
    };
  } else if (!isOSeries) {
    clientOptions.maxTokens = maxOutputTokens;
  }
  if (params.temperature != null && !isGpt5Plus && !isOSeries) {
    clientOptions.temperature = params.temperature;
  }
  if (!params.thinking && isCustomGateway(providerConfig)) {
    clientOptions.modelKwargs = withEnableThinking(clientOptions.modelKwargs, false);
  }
  if (options.configOptions) {
    clientOptions.configuration = options.configOptions;
  }

  const body = runtime.requestBody as
    | { messageId?: string; conversationId?: string; parentMessageId?: string }
    | undefined;
  resolveConfigHeaders({
    llmConfig: clientOptions,
    user: createSafeUser(runtime.user),
    tenantId: params.tenantId ?? runtime.user?.tenantId,
    body: {
      messageId: body?.messageId,
      conversationId: body?.conversationId,
      parentMessageId: body?.parentMessageId,
    },
  });

  const chat = initializeModel({
    provider,
    clientOptions: { ...clientOptions, streaming: false, disableStreaming: true } as ClientOptions,
  }) as AuxiliaryChat;

  return {
    model,
    chat,
    contextTokens: getModelMaxTokens(
      model,
      endpoint as EModelEndpoint,
      options.endpointTokenConfig,
    ),
  };
}
