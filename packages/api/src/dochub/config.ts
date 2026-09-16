import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import { dochubAgentSchema, dochubLimitsSchema, dochubSearchSchema } from 'librechat-data-provider';
import type { TDochubConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { KeyObject } from 'node:crypto';
import type { DochubRuntimeConfig } from './types';

export interface DochubResolvedConfig {
  runtime: DochubRuntimeConfig;
  key: KeyObject;
  /** `host:port` entries the base URL is allowed to point at, when configured. */
  allowedAddresses?: string[];
}

interface KeyCacheEntry {
  source: string;
  key: KeyObject;
}

let keyCache: KeyCacheEntry | undefined;
const warnedMessages = new Set<string>();

/**
 * Config is resolved on every tool call, so an unchanged misconfiguration must
 * not fill the log with the same line.
 */
function warnOnce(message: string): undefined {
  if (!warnedMessages.has(message)) {
    warnedMessages.add(message);
    logger.warn(`[dochub] integration disabled: ${message}`);
  }
  return undefined;
}

/** Test seam: the caches outlive a single resolution by design. */
export function resetDochubConfigCache(): void {
  keyCache = undefined;
  warnedMessages.clear();
}

/**
 * The private key never leaves this module as a string: it is parsed into a
 * `KeyObject` once and cached by its source, so it cannot end up in a log line,
 * a config endpoint response or an error message.
 */
function resolveKey(config: TDochubConfig): KeyObject | undefined {
  const path = config.privateKeyPath ?? process.env.DOCHUB_INTEGRATION_PRIVATE_KEY_PATH;
  const inline = process.env.DOCHUB_INTEGRATION_PRIVATE_KEY;
  if (!path && !inline) {
    return warnOnce(
      'no private key — set dochub.privateKeyPath or DOCHUB_INTEGRATION_PRIVATE_KEY_PATH',
    );
  }
  const source = path ? `path:${path}` : 'env';
  if (keyCache?.source === source) {
    return keyCache.key;
  }

  let pem: string;
  try {
    pem = path ? readFileSync(path, 'utf8') : (inline as string).replace(/\\n/g, '\n');
  } catch (error) {
    return warnOnce(
      `cannot read the private key from ${path} — ${(error as Error).message ?? 'unknown error'}`,
    );
  }

  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ec') {
      return warnOnce(
        `the private key must be EC P-256, got ${key.asymmetricKeyType ?? 'unknown'}`,
      );
    }
    if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      return warnOnce(
        `the private key must use curve prime256v1, got ${key.asymmetricKeyDetails?.namedCurve ?? 'unknown'}`,
      );
    }
    keyCache = { source, key };
    return key;
  } catch (error) {
    return warnOnce(`the private key cannot be parsed — ${(error as Error).message}`);
  }
}

function resolveBaseURL(config: TDochubConfig): string | undefined {
  const raw = (config.baseURL ?? process.env.DOCHUB_BASE_URL ?? '').trim();
  if (!raw) {
    return warnOnce('no baseURL — set dochub.baseURL or DOCHUB_BASE_URL');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return warnOnce(`baseURL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return warnOnce(`baseURL must be http(s), got ${url.protocol}`);
  }
  if (url.username || url.password) {
    return warnOnce('baseURL must not carry credentials');
  }

  const allowed = config.allowedAddresses?.filter((entry): entry is string => !!entry);
  if (allowed?.length) {
    const target = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    if (!allowed.includes(target)) {
      return warnOnce(`baseURL host ${target} is not in dochub.allowedAddresses`);
    }
  }
  return raw.replace(/\/+$/, '');
}

/**
 * Resolves the `dochub` block into everything a tool call needs, or `undefined`
 * when the integration cannot run. Never throws: a broken DocHub configuration
 * must not stop the server from starting — the tools simply do not appear.
 */
export function resolveDochubConfig(
  config: TDochubConfig | undefined,
): DochubResolvedConfig | undefined {
  if (!config || config.enabled !== true) {
    return undefined;
  }

  const baseURL = resolveBaseURL(config);
  if (!baseURL) {
    return undefined;
  }
  const keyId = (config.keyId ?? process.env.DOCHUB_INTEGRATION_KID ?? '').trim();
  if (!keyId) {
    return warnOnce('no keyId — set dochub.keyId or DOCHUB_INTEGRATION_KID');
  }
  const key = resolveKey(config);
  if (!key) {
    return undefined;
  }

  return {
    runtime: {
      baseURL,
      keyId,
      issuer: config.issuer ?? process.env.DOCHUB_ISSUER ?? 'librechat',
      audience: config.audience ?? process.env.DOCHUB_AUDIENCE ?? 'dochub-integration',
      tokenTtlSeconds: config.tokenTtlSeconds ?? 60,
      requestTimeoutMs: config.requestTimeoutMs ?? 20000,
      limits: dochubLimitsSchema.parse(config.limits ?? {}),
      agent: dochubAgentSchema.parse(config.agent ?? {}),
      search: dochubSearchSchema.parse(config.search ?? {}),
    },
    key,
    allowedAddresses: config.allowedAddresses?.filter((entry): entry is string => !!entry),
  };
}

/**
 * Whether the DocHub tools should exist at all. Called at startup to keep them
 * out of the tool cache — that is what hides them from the agent builder and
 * from the model, not the manifest entry.
 */
export function isDochubConfigured(appConfig: Pick<AppConfig, 'dochub'> | undefined): boolean {
  return resolveDochubConfig(appConfig?.dochub) != null;
}
