import { dochubSchema } from 'librechat-data-provider';

import type { TCustomConfig, TDochubConfig } from 'librechat-data-provider';

import logger from '~/config/winston';

/**
 * Fills in the defaults of the `dochub` block so every consumer reads the same
 * numbers. Whether the integration can actually run — private key, reachable
 * base URL — is decided later, where the key material is resolved.
 */
export function loadDochubConfig(config: TCustomConfig['dochub']): TDochubConfig | undefined {
  if (!config || config.enabled !== true) {
    return undefined;
  }

  const parsed = dochubSchema.safeParse(config);
  if (!parsed.success) {
    logger.warn(
      `[dochub] integration disabled: invalid configuration — ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'dochub'}: ${issue.message}`)
        .join('; ')}`,
    );
    return undefined;
  }

  return parsed.data;
}
