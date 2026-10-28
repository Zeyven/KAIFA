/**
 * Sensitive-field redaction (invariant I26, spec §16.1/§16.3).
 * Logs may never contain: passwords, tokens, authorization headers, payment
 * secrets, full phone numbers, ID/bank numbers.
 */

const SECRET_KEY_RE =
  /(password|passwd|secret|token|authorization|apikey|api_key|private_key|credential|cookie|jwt|session_id|idempotency_key)/i;

/** Mask a phone number: 138****1234 (last 4 visible, prefix 3). */
export function maskPhone(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  // normalize common country prefix so masking is stable for display
  if (digits.startsWith('86') && digits.length >= 13) digits = digits.slice(2);
  if (digits.length < 7) return '***';
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

/** Deep-clone into a log-safe structure: secret-ish keys → '[redacted]', phones masked. */
export function redactForLog<T>(value: T): T {
  return redactValue(value, '') as T;
}

function redactValue(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return value;
  if (SECRET_KEY_RE.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    if (/^\+?\d{7,15}$/.test(value)) return maskPhone(value);
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((v) => redactValue(v, key));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, k);
    }
    return out;
  }
  return value;
}

/** pino `redact.paths` — structural belt next to the deep redactor. */
export const PINO_REDACT_PATHS = [
  'password',
  'token',
  'secret',
  '*.password',
  '*.token',
  '*.secret',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'phone',
  '*.phone',
  'phoneEncrypted',
  '*.phoneEncrypted',
  'jwt',
  '*.jwt',
];
