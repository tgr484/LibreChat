import { logger } from '@librechat/data-schemas';
import { Constants } from 'librechat-data-provider';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type { EndpointDbMethods, ServerRequest } from '~/types';
import type { DochubPhase, RunBudget } from './budget';
import type { DochubAgentSettings } from './types';
import { createAuxiliaryModel, extractText, stripReasoning } from '~/endpoints/auxiliary';
import { getProviderConfig } from '~/endpoints/config/providers';
import { resolveRequestTenantId } from '~/middleware/tenant';
import { stoppedError } from './budget';
import { DochubError } from './errors';

/** The agent that called the tool; its endpoint and model are the defaults. */
export interface DochubLlmAgent {
  endpoint?: string;
  provider?: string;
  model?: string;
  model_parameters?: { model?: string };
  /** Present on DocHub agents: the one collection their tools may use. */
  dochub?: { collection_id: number; collection_name?: string };
}

export interface DochubLlm {
  model: string;
  /** Context window when the model is known to LibreChat; used to split big chapters. */
  contextTokens?: number;
  /** `work` calls stop when the work phase ends; `reduce` calls run into the reserve. */
  invoke(prompt: string, budget: RunBudget, phase?: DochubPhase): Promise<string>;
}

export { extractText, stripReasoning };

const CUT_OFF_REASONING = /<think>(?![\s\S]*<\/think>)/i;

/**
 * Resolves the model the sub-agent runs on: by default the endpoint and model
 * of the chat that called the tool, through the same provider resolution the
 * chat itself uses — so a custom endpoint (an internal LiteLLM gateway), its
 * keys, proxy headers and SSRF guards all apply unchanged.
 * The option sanitising lives in `createAuxiliaryModel`.
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
  if (settings.endpoint != null && settings.endpoint !== agentEndpoint) {
    try {
      getProviderConfig({ provider: settings.endpoint, appConfig });
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

  const { chat, contextTokens } = await createAuxiliaryModel({
    runtime: { appConfig, user: req.user as IUser | undefined, requestBody: req.body ?? {} },
    endpoint,
    model,
    maxOutputTokens: settings.maxOutputTokens,
    temperature: settings.temperature,
    thinking: settings.thinking,
    db,
    fallbackProvider: agent?.provider,
    tenantId: resolveRequestTenantId(req),
  });

  return {
    model,
    contextTokens,
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
