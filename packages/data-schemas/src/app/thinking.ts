import { thinkingSchema } from 'librechat-data-provider';

import type { TCustomConfig, TThinkingConfig } from 'librechat-data-provider';

import logger from '~/config/winston';

/** Fills in the defaults of the `thinking` block, or leaves the feature off. */
export function loadThinkingConfig(config: TCustomConfig['thinking']): TThinkingConfig | undefined {
  if (!config) {
    return undefined;
  }

  const parsed = thinkingSchema.safeParse(config);
  if (!parsed.success) {
    logger.warn(
      `[thinking] classifier disabled: invalid configuration — ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'thinking'}: ${issue.message}`)
        .join('; ')}`,
    );
    return undefined;
  }

  return parsed.data.enabled ? parsed.data : undefined;
}
