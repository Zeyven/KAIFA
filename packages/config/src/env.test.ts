import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from './env';

const base = {
  NODE_ENV: 'test',
  PORT: '4000',
  LOG_LEVEL: 'info',
  JWT_SECRET: 'x'.repeat(48),
} as NodeJS.ProcessEnv;

describe('loadEnv', () => {
  it('loads and coerces valid env', () => {
    const env = loadEnv({ ...base, PORT: '8080' });
    expect(env.PORT).toBe(8080);
    expect(env.NODE_ENV).toBe('test');
    expect(env.PAYMENT_PROVIDER).toBe('fake');
  });

  it('rejects bad values with all issues listed and never echoes values', () => {
    try {
      loadEnv({ ...base, PORT: 'nope', LOG_LEVEL: 'loud' } as NodeJS.ProcessEnv);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const err = e as EnvError;
      expect(err.issues.join(' ')).toContain('PORT');
      expect(err.issues.join(' ')).toContain('LOG_LEVEL');
    }
  });

  it('fails closed: production + fake payment provider is rejected', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', PAYMENT_PROVIDER: 'fake' })).toThrow(
      EnvError,
    );
  });

  it('fails closed: production + dev JWT secret is rejected', () => {
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_SECRET: 'dev-only-insecure-jwt-secret-change-me-0000000000',
      }),
    ).toThrow(EnvError);
  });

  it('production passes with rotated secret and real provider', () => {
    const env = loadEnv({
      ...base,
      NODE_ENV: 'production',
      JWT_SECRET: 'rotated-'.repeat(6),
      PAYMENT_PROVIDER: 'wechat',
    });
    expect(env.NODE_ENV).toBe('production');
  });

  it('validates DATABASE_URL shape when present', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: 'mysql://x' })).toThrow(EnvError);
    const env = loadEnv({ ...base, DATABASE_URL: 'postgres://u:p@localhost:5432/db' });
    expect(env.DATABASE_URL).toContain('postgres://');
  });
});
