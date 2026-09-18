import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { TDochubConfig } from 'librechat-data-provider';
import { isDochubConfigured, resetDochubConfigCache, resolveDochubConfig } from './config';

const dir = mkdtempSync(join(tmpdir(), 'dochub-config-'));

const writeKey = (name: string, namedCurve = 'prime256v1'): string => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve });
  const path = join(dir, name);
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  return path;
};

const ecKeyPath = writeKey('ec.pem');

const baseConfig = (overrides: Partial<TDochubConfig> = {}): TDochubConfig => ({
  enabled: true,
  baseURL: 'http://dochub:8000/api/integration/v1',
  keyId: '2026-09',
  privateKeyPath: ecKeyPath,
  ...overrides,
});

describe('resolveDochubConfig', () => {
  beforeEach(() => {
    resetDochubConfigCache();
    delete process.env.DOCHUB_BASE_URL;
    delete process.env.DOCHUB_INTEGRATION_KID;
    delete process.env.DOCHUB_INTEGRATION_PRIVATE_KEY;
    delete process.env.DOCHUB_INTEGRATION_PRIVATE_KEY_PATH;
  });

  it('resolves defaults and keeps the key out of the returned object', () => {
    const resolved = resolveDochubConfig(baseConfig());

    expect(resolved?.runtime).toMatchObject({
      baseURL: 'http://dochub:8000/api/integration/v1',
      issuer: 'librechat',
      audience: 'dochub-integration',
      keyId: '2026-09',
      tokenTtlSeconds: 60,
    });
    expect(resolved?.runtime.limits.wallClockMs).toBe(1800000);
    expect(resolved?.runtime.search.defaultTopK).toBe(8);
    expect(resolved?.runtime.agent.temperature).toBe(0);
    expect(resolved?.runtime.agent.thinking).toBe(false);
    expect(resolved?.runtime.limits.llmCallTimeoutMs).toBe(240000);
    expect(resolved?.key.asymmetricKeyType).toBe('ec');
    expect(JSON.stringify(resolved?.runtime)).not.toContain('PRIVATE KEY');
  });

  it('keeps configured limits', () => {
    const resolved = resolveDochubConfig(
      baseConfig({ limits: { wallClockMs: 120000, maxChapters: 5 } }),
    );
    expect(resolved?.runtime.limits.wallClockMs).toBe(120000);
    expect(resolved?.runtime.limits.maxChapters).toBe(5);
    /** Unset fields still come from the schema defaults. */
    expect(resolved?.runtime.limits.maxLlmCalls).toBe(300);
  });

  it('trims a trailing slash so route paths join cleanly', () => {
    const resolved = resolveDochubConfig(
      baseConfig({ baseURL: 'http://dochub:8000/api/integration/v1/' }),
    );
    expect(resolved?.runtime.baseURL).toBe('http://dochub:8000/api/integration/v1');
  });

  it('reads the key and the base URL from the environment', () => {
    process.env.DOCHUB_BASE_URL = 'http://dochub:8000/api/integration/v1';
    process.env.DOCHUB_INTEGRATION_KID = 'env-kid';
    process.env.DOCHUB_INTEGRATION_PRIVATE_KEY_PATH = ecKeyPath;

    const resolved = resolveDochubConfig({ enabled: true });
    expect(resolved?.runtime.keyId).toBe('env-kid');
  });

  it.each([
    ['the integration is off', { enabled: false }],
    ['there is no base URL', { baseURL: undefined }],
    ['the base URL is not a URL', { baseURL: 'dochub:8000' }],
    ['the base URL is not http', { baseURL: 'ftp://dochub:8000/v1' }],
    ['the base URL carries credentials', { baseURL: 'http://user:pw@dochub:8000/v1' }],
    ['there is no key id', { keyId: undefined }],
    ['the key file is missing', { privateKeyPath: join(dir, 'absent.pem') }],
    [
      'the host is outside allowedAddresses',
      { allowedAddresses: ['other:8000'] } as Partial<TDochubConfig>,
    ],
  ])('returns undefined when %s', (_label, overrides) => {
    expect(resolveDochubConfig(baseConfig(overrides))).toBeUndefined();
  });

  it('refuses a key that is not EC P-256', () => {
    expect(
      resolveDochubConfig(baseConfig({ privateKeyPath: writeKey('p384.pem', 'secp384r1') })),
    ).toBeUndefined();

    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPath = join(dir, 'rsa.pem');
    writeFileSync(rsaPath, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
    expect(resolveDochubConfig(baseConfig({ privateKeyPath: rsaPath }))).toBeUndefined();
  });

  it('accepts a host that is in allowedAddresses', () => {
    expect(
      resolveDochubConfig(baseConfig({ allowedAddresses: ['dochub:8000'] })),
    ).not.toBeUndefined();
  });
});

describe('isDochubConfigured', () => {
  beforeEach(resetDochubConfigCache);

  it('is what hides the tools when the integration cannot run', () => {
    expect(isDochubConfigured(undefined)).toBe(false);
    expect(isDochubConfigured({ dochub: undefined })).toBe(false);
    expect(isDochubConfigured({ dochub: { enabled: true } })).toBe(false);
    expect(isDochubConfigured({ dochub: baseConfig() })).toBe(true);
  });
});
