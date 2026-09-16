import jwt from 'jsonwebtoken';
import { generateKeyPairSync } from 'node:crypto';
import type { IUser } from '@librechat/data-schemas';
import type { DochubRuntimeConfig } from './types';
import { resolveDochubSubject, signDochubToken } from './token';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

const runtime: DochubRuntimeConfig = {
  baseURL: 'http://dochub:8000/api/integration/v1',
  issuer: 'librechat',
  audience: 'dochub-integration',
  keyId: '2026-09',
  tokenTtlSeconds: 60,
  requestTimeoutMs: 20000,
  limits: {
    wallClockMs: 600000,
    reduceReserveMs: 45000,
    maxHttpRequests: 150,
    maxLlmCalls: 80,
    maxChapters: 40,
    maxChapterChars: 30000,
    maxDocuments: 6,
    chapterConcurrency: 4,
    documentConcurrency: 3,
    extractionCharLimit: 1200,
    resultCharLimit: 6000,
  },
  agent: { temperature: 0, maxOutputTokens: 900 },
  search: { defaultTopK: 8, maxTopK: 20, slotRetries: 2, slotRetryDelayMs: 4000 },
};

const ldapUser = (overrides: Partial<IUser> = {}): IUser =>
  ({
    id: '65f0c3a1b2c3d4e5f6a7b8c9',
    provider: 'ldap',
    ldapId: 'ivanov',
    ...overrides,
  }) as IUser;

describe('resolveDochubSubject', () => {
  it('takes the LDAP login from the session and lowercases it', () => {
    expect(resolveDochubSubject(ldapUser({ ldapId: '  IVANOV  ' }))).toEqual({
      ok: true,
      sub: 'ivanov',
      lcUid: '65f0c3a1b2c3d4e5f6a7b8c9',
    });
  });

  it('refuses sessions that did not come from LDAP', () => {
    expect(resolveDochubSubject(ldapUser({ provider: 'openid' }))).toEqual({
      ok: false,
      reason: 'not_ldap',
    });
    expect(resolveDochubSubject(undefined)).toEqual({ ok: false, reason: 'not_ldap' });
  });

  it('refuses a missing login', () => {
    expect(resolveDochubSubject(ldapUser({ ldapId: '   ' }))).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  /** DocHub answers 401 for these and tells clients not to retry — fail locally instead. */
  it.each([
    ['an email, as the LDAP strategy falls back to mail', 'ivanov@corp.rn-t.ru'],
    ['a distinguished name', 'cn=ivanov,ou=users,dc=corp'],
    ['cyrillic', 'иванов'],
    ['the b64 prefix DocHub rejects', 'b64:aXZhbm92'],
    ['more than 64 characters', 'i'.repeat(65)],
  ])('refuses %s', (_label, ldapId) => {
    expect(resolveDochubSubject(ldapUser({ ldapId }))).toEqual({
      ok: false,
      reason: 'invalid_format',
    });
  });

  it('omits lc_uid when the LibreChat id is not log-safe', () => {
    const subject = resolveDochubSubject(ldapUser({ id: 'user/with/slashes' }));
    expect(subject).toEqual({ ok: true, sub: 'ivanov', lcUid: undefined });
  });
});

describe('signDochubToken', () => {
  const sign = (sub = 'ivanov', lcUid?: string) =>
    signDochubToken({ config: runtime, key: privateKey, sub, lcUid });

  it('produces a token DocHub accepts: ES256, kid, and every required claim', () => {
    const token = sign('ivanov', '65f0c3a1b2c3d4e5f6a7b8c9');

    const header = JSON.parse(
      Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
    ) as Record<string, string>;
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe('2026-09');

    const claims = jwt.verify(token, publicKey, {
      algorithms: ['ES256'],
      issuer: 'librechat',
      audience: 'dochub-integration',
    }) as jwt.JwtPayload & { provider: string; lc_uid?: string };

    expect(claims.sub).toBe('ivanov');
    expect(claims.provider).toBe('ldap');
    expect(claims.lc_uid).toBe('65f0c3a1b2c3d4e5f6a7b8c9');
    expect(claims.jti).toEqual(expect.any(String));
    expect((claims.exp as number) - (claims.iat as number)).toBe(60);
  });

  it('omits lc_uid when there is none', () => {
    const claims = jwt.decode(sign()) as jwt.JwtPayload;
    expect(claims).not.toHaveProperty('lc_uid');
  });

  /** A repeated jti is a 401 at DocHub: one token per request, retries included. */
  it('never repeats a jti', () => {
    const ids = new Set(
      Array.from({ length: 25 }, () => (jwt.decode(sign()) as jwt.JwtPayload).jti),
    );
    expect(ids.size).toBe(25);
  });

  it('is rejected by a different public key', () => {
    const { publicKey: otherKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(() => jwt.verify(sign(), otherKey, { algorithms: ['ES256'] })).toThrow();
  });
});
