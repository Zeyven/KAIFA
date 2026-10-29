import { describe, expect, it } from 'vitest';
import { PasswordError, hashPassword, verifyPassword } from './password';

describe('password hashing (scrypt)', () => {
  it('hashes and verifies round-trip', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('wrong password', stored)).toBe(false);
  });

  it('is salted: same password → different hashes', async () => {
    const a = await hashPassword('same-password-123');
    const b = await hashPassword('same-password-123');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-123', a)).toBe(true);
    expect(await verifyPassword('same-password-123', b)).toBe(true);
  });

  it('rejects weak/invalid inputs without throwing secrets', async () => {
    await expect(hashPassword('short')).rejects.toThrow(PasswordError);
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$a$b$c$d$e')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$16384$8$1$AAAA$BBBB')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });

  it('rejects absurd stored scrypt params (crafted-hash DoS guard)', async () => {
    const evil = `scrypt$999999999$8$1$AAAA$BBBB`;
    expect(await verifyPassword('x', evil)).toBe(false);
  });

  it('rejects empty password verification gracefully', async () => {
    const stored = await hashPassword('long-enough-password');
    expect(await verifyPassword('', stored)).toBe(false);
    expect(await verifyPassword(undefined as unknown as string, stored)).toBe(false);
  });
});
