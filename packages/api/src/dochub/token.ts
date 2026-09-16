import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import type { IUser } from '@librechat/data-schemas';
import type { KeyObject } from 'node:crypto';
import type { DochubRuntimeConfig, DochubSignedToken, DochubSubject } from './types';

/** DocHub rejects anything else with `401`, so a mismatch never reaches the wire. */
const SUB_PATTERN = /^[a-z0-9._-]{1,64}$/;
/** `lc_uid` is audit-only; DocHub writes it to its log, so keep it log-safe. */
const LC_UID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * DocHub identifies the user by their LDAP login and nothing else. The login is
 * taken from the session, never from tool arguments, so a model cannot ask for
 * another user's documents.
 *
 * `ldapId` is only trustworthy for LDAP sessions: the LDAP strategy falls back
 * to `mail` when the configured id attribute is missing (`api/strategies/ldapStrategy.js`),
 * and an address with `@` is an unrecoverable `401` at DocHub — refusing here is
 * both cheaper and clearer.
 */
export function resolveDochubSubject(user: IUser | undefined): DochubSubject {
  if (!user || user.provider !== 'ldap') {
    return { ok: false, reason: 'not_ldap' };
  }
  const ldapId = typeof user.ldapId === 'string' ? user.ldapId.trim().toLowerCase() : '';
  if (!ldapId) {
    return { ok: false, reason: 'missing' };
  }
  if (!SUB_PATTERN.test(ldapId)) {
    return { ok: false, reason: 'invalid_format' };
  }
  const userId = typeof user.id === 'string' ? user.id : String(user._id ?? '');
  return {
    ok: true,
    sub: ldapId,
    lcUid: LC_UID_PATTERN.test(userId) ? userId : undefined,
  };
}

/**
 * One token per HTTP request: DocHub refuses a repeated `jti` with `401`, which
 * is what makes a stolen token useless. Never cache the return value, and sign
 * again for every retry.
 */
export function signDochubToken(params: {
  config: DochubRuntimeConfig;
  key: KeyObject;
  sub: string;
  lcUid?: string;
}): DochubSignedToken {
  const { config, key, sub, lcUid } = params;
  const jti = randomUUID();
  const token = jwt.sign(
    {
      provider: 'ldap',
      ...(lcUid != null ? { lc_uid: lcUid } : {}),
    },
    key,
    {
      algorithm: 'ES256',
      keyid: config.keyId,
      issuer: config.issuer,
      audience: config.audience,
      subject: sub,
      expiresIn: config.tokenTtlSeconds,
      jwtid: jti,
    },
  );
  /** `jti` comes back so the audit line can name the request without decoding it again. */
  return { token, jti };
}
