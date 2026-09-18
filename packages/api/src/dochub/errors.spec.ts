import type { DochubErrorKind } from './types';
import {
  DochubError,
  classifyResponse,
  describeForModel,
  errorFromResponse,
  mapDochubError,
} from './errors';

describe('classifyResponse', () => {
  /** One row per line of §7 of the DocHub contract. */
  it.each<[number, string | undefined, DochubErrorKind]>([
    [401, 'invalid_token', 'auth'],
    [403, 'forbidden', 'forbidden'],
    [403, 'account_conflict', 'account_conflict'],
    [404, 'Not Found', 'integration_off'],
    [404, 'collection_not_found', 'collection_not_found'],
    [404, 'not_found', 'not_found'],
    [409, 'version_mismatch', 'version_mismatch'],
    [422, 'chapter out of range', 'bad_request'],
    [429, 'rate_limited', 'rate_limited'],
    [429, 'ask_slot_busy', 'ask_slot_busy'],
    [503, 'ldap_unavailable', 'ldap_unavailable'],
    [503, 'integration_misconfigured', 'misconfigured'],
    [500, 'Internal server error', 'server'],
  ])('maps %s %s', (status, detail, expected) => {
    expect(classifyResponse(status, detail)).toBe(expected);
  });

  it('falls back to the status when the detail is unknown', () => {
    expect(classifyResponse(403, undefined)).toBe('forbidden');
    expect(classifyResponse(502, undefined)).toBe('server');
  });
});

describe('errorFromResponse', () => {
  it('marks the kinds worth retrying', () => {
    const retryable = (status: number, detail: string) =>
      errorFromResponse({ status, detail, route: '/collections' }).retryable;

    expect(retryable(401, 'invalid_token')).toBe(true);
    expect(retryable(429, 'ask_slot_busy')).toBe(true);
    expect(retryable(503, 'ldap_unavailable')).toBe(true);
    expect(retryable(500, 'Internal server error')).toBe(true);

    expect(retryable(403, 'forbidden')).toBe(false);
    expect(retryable(404, 'not_found')).toBe(false);
    expect(retryable(409, 'version_mismatch')).toBe(false);
    expect(retryable(422, 'bad input')).toBe(false);
    expect(retryable(503, 'integration_misconfigured')).toBe(false);
  });
});

describe('mapDochubError', () => {
  it('keeps a DochubError as is', () => {
    const original = new DochubError({ kind: 'not_found', message: 'gone' });
    expect(mapDochubError(original, '/documents/1/outline')).toBe(original);
  });

  it('recognises timeouts, aborts and network failures', () => {
    expect(mapDochubError({ code: 'ECONNABORTED' }, '/collections').kind).toBe('timeout');
    expect(mapDochubError({ code: 'ERR_CANCELED' }, '/collections').kind).toBe('aborted');
    expect(mapDochubError({ name: 'AbortError' }, '/collections').kind).toBe('aborted');
    expect(mapDochubError(new Error('socket hang up'), '/collections').kind).toBe('network');
  });

  it('never marks an abort retryable', () => {
    expect(mapDochubError({ code: 'ERR_CANCELED' }, '/collections').retryable).toBe(false);
  });
});

describe('describeForModel', () => {
  const kinds: DochubErrorKind[] = [
    'auth',
    'forbidden',
    'account_conflict',
    'integration_off',
    'collection_not_found',
    'not_found',
    'version_mismatch',
    'bad_request',
    'rate_limited',
    'ask_slot_busy',
    'ldap_unavailable',
    'misconfigured',
    'server',
    'network',
    'timeout',
    'aborted',
    'budget',
  ];

  it('has a Russian instruction for every failure the model can meet', () => {
    for (const kind of kinds) {
      const message = describeForModel(new DochubError({ kind, message: kind }));
      expect(message).toMatch(/[А-Яа-я]/);
      expect(message.length).toBeGreaterThan(20);
    }
  });

  it('never leaks the raw status line to the model', () => {
    const error = errorFromResponse({
      status: 401,
      detail: 'invalid_token',
      route: '/collections',
    });
    expect(describeForModel(error)).not.toContain('401');
  });
});
