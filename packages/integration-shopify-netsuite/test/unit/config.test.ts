import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadServiceConfig } from '../../src/config.ts';

const key = `k1:${randomBytes(32).toString('base64')}`;
const base = { DATABASE_URL: 'postgres://u:p@h/db' };

describe('startup configuration fails closed', () => {
  it('requires encryption keys for runtime roles', () => {
    expect(() => loadServiceConfig('worker', base)).toThrow(/CREDENTIAL_ENCRYPTION_KEYS/);
    expect(loadServiceConfig('worker', { ...base, CREDENTIAL_ENCRYPTION_KEYS: key }).cipher).not.toBeNull();
  });
  it('forbids encryption keys for the maintenance role', () => {
    expect(() => loadServiceConfig('maintenance', { ...base, CREDENTIAL_ENCRYPTION_KEYS: key })).toThrow(
      /must not/,
    );
    expect(loadServiceConfig('maintenance', base).cipher).toBeNull();
  });
  it('refuses fixture overrides and weak sessions in production', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      CREDENTIAL_ENCRYPTION_KEYS: key,
      SHOPIFY_CLIENT_ID: 'a',
      SHOPIFY_CLIENT_SECRET: 'b',
      SESSION_SECRET: 'x'.repeat(40),
    };
    expect(() =>
      loadServiceConfig('api', { ...prod, SHOPIFY_BASE_URL_OVERRIDE: 'http://fixtures:4010' }),
    ).toThrow(/not permitted/);
    expect(() => loadServiceConfig('api', { ...prod, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    expect(loadServiceConfig('api', { ...prod, SHOPIFY_BASE_URL_OVERRIDE: '' }).production).toBe(true);
  });
});
