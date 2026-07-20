import { createHash } from 'crypto';

/**
 * Deterministic bucketing for percentage rollouts.
 *
 * bucket = first 32 bits of sha256("tenantId:flagKey:userId") scaled to [0, 100)
 *
 * Properties (each proven by a unit test):
 *  - Deterministic: same inputs -> same bucket, forever, stateless.
 *  - Sticky under ramp-up: raising the percentage only adds users, never
 *    removes them (a user's bucket never changes).
 *  - Uniform: sha256 avalanche gives an even spread across buckets.
 *  - Independent across flags: flagKey is hashed in, so a user's cohort in
 *    one flag says nothing about another flag's cohort.
 *  - Tenant-isolated cohorts: tenantId is hashed in.
 *
 * sha256 over murmur3: zero dependencies, identical output in any client
 * language (a future SDK can replicate bucketing exactly), and ~1 µs cost is
 * noise next to request I/O. The environment is deliberately NOT hashed:
 * a user lands in the same cohort across dev/staging/production, which makes
 * rollouts testable in staging before they hit production.
 */
export function bucket(tenantId: string, flagKey: string, userId: string): number {
  const digest = createHash('sha256').update(`${tenantId}:${flagKey}:${userId}`).digest();
  const n = digest.readUInt32BE(0);
  return (n / 0x1_0000_0000) * 100;
}
