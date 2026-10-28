import { describe, expect, it } from 'vitest';
import { maskPhone, redactForLog } from './redact';

describe('redaction (invariant I26)', () => {
  it('masks phones at log edge', () => {
    expect(maskPhone('13812341234')).toBe('138****1234');
    expect(maskPhone('+8613812341234')).toBe('138****1234');
    expect(maskPhone('123')).toBe('***');
  });

  it('redacts secret-ish keys at any depth', () => {
    const logged = redactForLog({
      ok: 'visible',
      password: 'hunter2',
      nested: { apiKey: 'k', JWT: 'j', deep: { clientSecret: 's' } },
      headers: { authorization: 'Bearer abc', cookie: 'sid=1' },
    });
    expect(logged).toEqual({
      ok: 'visible',
      password: '[redacted]',
      nested: { apiKey: '[redacted]', JWT: '[redacted]', deep: { clientSecret: '[redacted]' } },
      headers: { authorization: '[redacted]', cookie: '[redacted]' },
    });
  });

  it('masks phone-looking strings even under innocuous keys', () => {
    const logged = redactForLog({ customer: { contact: '13812341234' } });
    expect(logged.customer.contact).toBe('138****1234');
  });

  it('preserves structure, arrays, and non-sensitive values', () => {
    const input = { list: ['13812341234', 'plain'], n: 12, big: 100n, nil: null };
    const out = redactForLog(input);
    expect(out.list).toEqual(['138****1234', 'plain']);
    expect(out.n).toBe(12);
    expect(out.big).toBe('100'); // bigint serialized, never [object Object]
    expect(out.nil).toBeNull();
  });
});
