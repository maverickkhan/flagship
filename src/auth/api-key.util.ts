import { createHash, randomBytes, timingSafeEqual } from 'crypto';

export interface GeneratedApiKey {
  /** Full key — shown exactly once at creation time, never stored. */
  key: string;
  /** sha256 hex of the full key — the only thing persisted. */
  hash: string;
  /** Short display prefix for identification in UIs/logs. */
  prefix: string;
}

/**
 * 32 random bytes -> base64url. High-entropy random secrets need a fast,
 * indexable digest, not a work-factor hash: there is no dictionary to brute
 * force, and sha256 gives O(1) lookup by unique index (see README security).
 */
export function generateApiKey(): GeneratedApiKey {
  const key = `ff_${randomBytes(32).toString('base64url')}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 10) };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Constant-time comparison for the static admin token: unlike hashed API key
 * lookup, this is a direct compare of a long-lived secret, where `===` would
 * be a legitimate timing-attack surface. Comparing sha256 digests also
 * normalizes lengths.
 */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}
