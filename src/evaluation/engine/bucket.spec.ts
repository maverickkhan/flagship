import { bucket } from './bucket';

const TENANT = 'tenant-a';
const FLAG = 'new-checkout';

describe('bucket()', () => {
  it('returns values in [0, 100)', () => {
    for (let i = 0; i < 1000; i++) {
      const b = bucket(TENANT, FLAG, `user-${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });

  it('is deterministic: repeated calls always return the same bucket', () => {
    const first = bucket(TENANT, FLAG, 'user-42');
    for (let i = 0; i < 1000; i++) {
      expect(bucket(TENANT, FLAG, 'user-42')).toBe(first);
    }
  });

  it('is uniform: 100k users spread evenly across deciles (±1pp)', () => {
    const deciles = new Array(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      deciles[Math.floor(bucket(TENANT, FLAG, `user-${i}`) / 10)]++;
    }
    for (const count of deciles) {
      expect(count / n).toBeGreaterThan(0.09);
      expect(count / n).toBeLessThan(0.11);
    }
  });

  it('is independent across flags: 10% cohorts of two flags overlap ~1% of users', () => {
    const n = 50_000;
    let inBoth = 0;
    for (let i = 0; i < n; i++) {
      const user = `user-${i}`;
      const inA = bucket(TENANT, 'flag-a', user) < 10;
      const inB = bucket(TENANT, 'flag-b', user) < 10;
      if (inA && inB) inBoth++;
    }
    // Independent 10% cohorts intersect in ~1% of users; correlated cohorts
    // (flag key not hashed) would intersect in ~10%.
    expect(inBoth / n).toBeGreaterThan(0.005);
    expect(inBoth / n).toBeLessThan(0.02);
  });

  it('isolates cohorts across tenants: same flag+user differs by tenant', () => {
    const n = 50_000;
    let inBoth = 0;
    for (let i = 0; i < n; i++) {
      const user = `user-${i}`;
      const inA = bucket('tenant-a', FLAG, user) < 10;
      const inB = bucket('tenant-b', FLAG, user) < 10;
      if (inA && inB) inBoth++;
    }
    expect(inBoth / n).toBeLessThan(0.02);
  });
});
