import { describe, expect, it } from 'vitest';
import { redactSecrets, redactStructuredValue, containsSecret } from './redaction';

// ── redactSecrets ────────────────────────────────────────────────────────────

describe('redactSecrets', () => {
  it('redacts OpenAI-style sk- keys', () => {
    const input = 'Using key sk-abcdefghijklmnopqrstuvwxyz123456';
    const result = redactSecrets(input);
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(result).toContain('[REDACTED_KEY]');
  });

  it('redacts sk-proj- keys', () => {
    const input = 'Key: sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234';
    const result = redactSecrets(input);
    expect(result).not.toContain('sk-proj-');
    expect(result).toContain('[REDACTED_KEY]');
  });

  it('redacts api_key assignments', () => {
    const input = 'api_key=abcdefghijklmnop1234';
    const result = redactSecrets(input);
    expect(result).not.toContain('abcdefghijklmnop1234');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts Authorization Bearer tokens', () => {
    const input = 'Authorization: Bearer abcdefghijklmnop12345678';
    const result = redactSecrets(input);
    expect(result).not.toContain('abcdefghijklmnop12345678');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts JWT tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef1234567890abcdef1234567890';
    const result = redactSecrets(`token: ${jwt}`);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(result).toContain('[REDACTED_JWT]');
  });

  it('redacts AWS access key IDs', () => {
    const input = 'Key: AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(input);
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result).toContain('[REDACTED_AWS_KEY]');
  });

  it('redacts private key blocks', () => {
    const input =
      '-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBg...\n-----END PRIVATE KEY-----';
    const result = redactSecrets(input);
    expect(result).not.toContain('BEGIN PRIVATE KEY');
    expect(result).toContain('[REDACTED_PRIVATE_KEY]');
  });

  it('leaves normal text unchanged', () => {
    const input = 'Hello, this is a normal message with no secrets.';
    expect(redactSecrets(input)).toBe(input);
  });

  it('handles empty string', () => {
    expect(redactSecrets('')).toBe('');
  });
});

// ── redactStructuredValue ────────────────────────────────────────────────────

describe('redactStructuredValue', () => {
  it('redacts strings inside objects', () => {
    const input = { key: 'sk-abcdefghijklmnopqrstuvwxyz123456', name: 'test' };
    const result = redactStructuredValue(input);
    expect(result.key).toContain('[REDACTED_KEY]');
    expect(result.name).toBe('test');
  });

  it('redacts strings inside arrays', () => {
    const input = ['normal', 'sk-abcdefghijklmnopqrstuvwxyz123456'];
    const result = redactStructuredValue(input);
    expect(result[0]).toBe('normal');
    expect(result[1]).toContain('[REDACTED_KEY]');
  });

  it('handles nested objects', () => {
    const input = {
      outer: { inner: 'api_key=abcdefghijklmnop1234' },
    };
    const result = redactStructuredValue(input);
    expect(result.outer.inner).toContain('[REDACTED]');
  });

  it('passes through numbers and booleans unchanged', () => {
    const input = { count: 42, active: true };
    const result = redactStructuredValue(input);
    expect(result.count).toBe(42);
    expect(result.active).toBe(true);
  });

  it('passes through null and undefined unchanged', () => {
    expect(redactStructuredValue(null)).toBeNull();
    expect(redactStructuredValue(undefined)).toBeUndefined();
  });
});

// ── containsSecret ───────────────────────────────────────────────────────────

describe('containsSecret', () => {
  it('detects OpenAI keys', () => {
    expect(containsSecret('sk-abcdefghijklmnopqrstuvwxyz123456')).toBe(true);
  });

  it('detects api_key assignments', () => {
    expect(containsSecret('api_key=abcdefghijklmnop1234')).toBe(true);
  });

  it('returns false for normal text', () => {
    expect(containsSecret('Hello world, no secrets here.')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(containsSecret('')).toBe(false);
  });

  it('detects JWT tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef1234567890abcdef1234567890';
    expect(containsSecret(jwt)).toBe(true);
  });
});
