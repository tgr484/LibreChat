import type { DochubResolvedConfig } from './config';
import type { ServerRequest } from '~/types';
import type { DochubClient } from './client';
import type { RunBudget } from './budget';
import { resolveDochubConfig } from './config';
import { resolveDochubSubject } from './token';
import { createDochubClient } from './client';
import { createRunBudget } from './budget';

export type DochubSessionFailure = 'not_configured' | 'not_ldap' | 'no_identity';

export interface DochubSession {
  client: DochubClient;
  budget: RunBudget;
  config: DochubResolvedConfig;
  sub: string;
}

export type DochubSessionResult =
  | { ok: true; session: DochubSession }
  | { ok: false; reason: DochubSessionFailure };

/**
 * Everything one DocHub interaction needs, acting as the requesting user and
 * never anyone else. The caller owns the budget and must dispose it.
 */
export function openDochubSession(params: {
  req: ServerRequest;
  signal?: AbortSignal;
}): DochubSessionResult {
  const config = resolveDochubConfig(params.req.config?.dochub);
  if (!config) {
    return { ok: false, reason: 'not_configured' };
  }

  const subject = resolveDochubSubject(params.req.user);
  if (!subject.ok) {
    return { ok: false, reason: subject.reason === 'not_ldap' ? 'not_ldap' : 'no_identity' };
  }

  const budget = createRunBudget({
    limits: config.runtime.limits,
    parentSignal: params.signal,
  });
  const client = createDochubClient({
    config: config.runtime,
    key: config.key,
    subject,
    budget,
  });
  return { ok: true, session: { client, budget, config, sub: subject.sub } };
}
