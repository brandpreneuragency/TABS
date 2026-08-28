// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Secret redaction
// Runs before every event, log, artifact summary, and error display.
// Pure functions — no side effects.
// ---------------------------------------------------------------------------

/**
 * Patterns that match common secret formats in free text.
 * Each entry is a [pattern, replacement] pair.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // OpenAI-style keys: sk-... or sk-proj-...
  [/\bsk(?:-proj)?-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_KEY]'],
  // JWT tokens (three base64url segments separated by dots) — before hex
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
   '[REDACTED_JWT]'],
  // Generic API key assignments in URLs, headers, or query strings
  [/(api[_-]?key|apikey|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer)\s*[=:]\s*["']?[A-Za-z0-9_\-./+]{16,}["']?/gi,
   '$1=[REDACTED]'],
  // Authorization header values (Bearer ..., Token ...)
  [/(authorization|auth)\s*[=:]\s*["']?(?:Bearer|Token)\s+[A-Za-z0-9_\-./+]{16,}["']?/gi,
   '$1=[REDACTED]'],
  // Generic long hex strings that look like tokens (32+ hex chars)
  [/\b[0-9a-f]{32,}\b/gi, '[REDACTED_HEX]'],
  // AWS-style access key IDs
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  // Private key blocks
  [/-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
   '[REDACTED_PRIVATE_KEY]'],
];

/**
 * Redact secrets from a string.
 *
 * Runs all patterns in order. A substring already replaced by an earlier
 * pattern will not be scanned again.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Redact secrets from a structured value.
 *
 * Strings are run through `redactSecrets`. Arrays and plain objects are
 * traversed recursively. Other types are returned unchanged.
 */
export function redactStructuredValue<T>(value: T): T {
  if (typeof value === 'string') {
    return redactSecrets(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map(redactStructuredValue) as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = redactStructuredValue(
        (value as Record<string, unknown>)[key],
      );
    }
    return out as T;
  }
  return value;
}

/**
 * Check whether a string looks like it contains a secret.
 * Useful for pre-flight checks before persisting or logging.
 */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some(([pattern]) => {
    // Reset lastIndex for global regexps.
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}
