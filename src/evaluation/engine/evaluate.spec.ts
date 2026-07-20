import { bucket } from './bucket';
import { evaluateFlag } from './evaluate';
import type { EvaluableFlag, FlagValue } from './types';

const TENANT = 'tenant-a';

function makeFlag(overrides: {
  type?: EvaluableFlag['type'];
  status?: EvaluableFlag['status'];
  defaultValue?: FlagValue;
  enabled?: boolean;
  serveValue?: FlagValue;
  rolloutPercentage?: number;
  targetingRules?: EvaluableFlag['environment']['targetingRules'];
  variants?: EvaluableFlag['environment']['variants'];
  key?: string;
}): EvaluableFlag {
  return {
    key: overrides.key ?? 'test-flag',
    type: overrides.type ?? 'boolean',
    status: overrides.status ?? 'active',
    defaultValue: overrides.defaultValue ?? false,
    environment: {
      enabled: overrides.enabled ?? true,
      serveValue: overrides.serveValue ?? true,
      rolloutPercentage: overrides.rolloutPercentage ?? 100,
      targetingRules: overrides.targetingRules ?? [],
      variants: overrides.variants ?? null,
    },
  };
}

/** Find a user id whose bucket for the flag is inside/outside a percentage. */
function findUser(flagKey: string, pct: number, inside: boolean): string {
  for (let i = 0; i < 10_000; i++) {
    const user = `probe-${i}`;
    const inRollout = bucket(TENANT, flagKey, user) < pct;
    if (inRollout === inside) return user;
  }
  throw new Error('no probe user found');
}

describe('evaluateFlag() serve-semantics matrix', () => {
  const cases: Array<{
    type: EvaluableFlag['type'];
    defaultValue: FlagValue;
    serveValue: FlagValue;
  }> = [
    { type: 'boolean', defaultValue: false, serveValue: true },
    { type: 'string', defaultValue: 'control', serveValue: 'treatment' },
    { type: 'number', defaultValue: 250, serveValue: 500 },
  ];

  for (const { type, defaultValue, serveValue } of cases) {
    describe(`${type} flag`, () => {
      it('archived -> default value, FLAG_ARCHIVED', () => {
        const flag = makeFlag({ type, defaultValue, serveValue, status: 'archived' });
        expect(evaluateFlag(TENANT, flag, 'u1')).toEqual({
          value: defaultValue,
          reason: 'FLAG_ARCHIVED',
        });
      });

      it('disabled -> default value, FLAG_DISABLED', () => {
        const flag = makeFlag({ type, defaultValue, serveValue, enabled: false });
        expect(evaluateFlag(TENANT, flag, 'u1')).toEqual({
          value: defaultValue,
          reason: 'FLAG_DISABLED',
        });
      });

      it('targeting match -> rule serve value, TARGETING_MATCH', () => {
        const flag = makeFlag({
          type,
          defaultValue,
          serveValue,
          targetingRules: [
            { attribute: 'country', operator: 'in', values: ['PK', 'US'], serve: serveValue },
          ],
        });
        expect(evaluateFlag(TENANT, flag, 'u1', { country: 'PK' })).toEqual({
          value: serveValue,
          reason: 'TARGETING_MATCH',
        });
      });

      it('out of rollout -> default value, ROLLOUT_MISS', () => {
        const flag = makeFlag({ type, defaultValue, serveValue, rolloutPercentage: 30 });
        const outside = findUser(flag.key, 30, false);
        expect(evaluateFlag(TENANT, flag, outside)).toEqual({
          value: defaultValue,
          reason: 'ROLLOUT_MISS',
        });
      });

      it('in rollout -> serve value, ROLLOUT_MATCH', () => {
        const flag = makeFlag({ type, defaultValue, serveValue, rolloutPercentage: 30 });
        const inside = findUser(flag.key, 30, true);
        expect(evaluateFlag(TENANT, flag, inside)).toEqual({
          value: serveValue,
          reason: 'ROLLOUT_MATCH',
        });
      });

      it('enabled at 100% -> serve value, FALLTHROUGH', () => {
        const flag = makeFlag({ type, defaultValue, serveValue, rolloutPercentage: 100 });
        expect(evaluateFlag(TENANT, flag, 'u1')).toEqual({
          value: serveValue,
          reason: 'FALLTHROUGH',
        });
      });
    });
  }
});

describe('rollout stickiness', () => {
  it('every user enabled at 20% stays enabled at 50%', () => {
    const at = (pct: number, user: string) =>
      evaluateFlag(TENANT, makeFlag({ rolloutPercentage: pct }), user).reason === 'ROLLOUT_MATCH';
    let enabledAt20 = 0;
    for (let i = 0; i < 5000; i++) {
      const user = `user-${i}`;
      if (at(20, user)) {
        enabledAt20++;
        expect(at(50, user)).toBe(true);
      }
    }
    expect(enabledAt20).toBeGreaterThan(500); // sanity: ~20% of 5000
  });
});

describe('targeting rules', () => {
  it('first matching rule wins', () => {
    const flag = makeFlag({
      type: 'string',
      defaultValue: 'control',
      serveValue: 'fallthrough',
      targetingRules: [
        { attribute: 'plan', operator: 'eq', values: ['pro'], serve: 'first' },
        { attribute: 'plan', operator: 'in', values: ['pro', 'team'], serve: 'second' },
      ],
    });
    expect(evaluateFlag(TENANT, flag, 'u1', { plan: 'pro' }).value).toBe('first');
  });

  it('missing context attribute does not match', () => {
    const flag = makeFlag({
      targetingRules: [{ attribute: 'country', operator: 'eq', values: ['PK'], serve: true }],
      rolloutPercentage: 0,
    });
    expect(evaluateFlag(TENANT, flag, 'u1', {}).reason).toBe('ROLLOUT_MISS');
  });
});

describe('weighted variants', () => {
  const variants = [
    { value: 'green', weight: 50 },
    { value: 'red', weight: 30 },
    { value: 'blue', weight: 20 },
  ];

  it('distribution approximates weights at 100% rollout', () => {
    const counts: Record<string, number> = { green: 0, red: 0, blue: 0 };
    const n = 30_000;
    const flag = makeFlag({ type: 'string', defaultValue: 'control', variants });
    for (let i = 0; i < n; i++) {
      counts[evaluateFlag(TENANT, flag, `user-${i}`).value as string]++;
    }
    expect(counts.green / n).toBeCloseTo(0.5, 1);
    expect(counts.red / n).toBeCloseTo(0.3, 1);
    expect(counts.blue / n).toBeCloseTo(0.2, 1);
  });

  it('variant assignment is deterministic per user', () => {
    const flag = makeFlag({ type: 'string', defaultValue: 'control', variants });
    const first = evaluateFlag(TENANT, flag, 'user-7').value;
    for (let i = 0; i < 100; i++) {
      expect(evaluateFlag(TENANT, flag, 'user-7').value).toBe(first);
    }
  });

  it('variant proportions hold inside a partial rollout', () => {
    const flag = makeFlag({
      type: 'string',
      defaultValue: 'control',
      variants,
      rolloutPercentage: 40,
    });
    const counts: Record<string, number> = { green: 0, red: 0, blue: 0, control: 0 };
    const n = 30_000;
    for (let i = 0; i < n; i++) {
      counts[evaluateFlag(TENANT, flag, `user-${i}`).value as string]++;
    }
    const inRollout = n - counts.control;
    expect(inRollout / n).toBeCloseTo(0.4, 1);
    expect(counts.green / inRollout).toBeCloseTo(0.5, 1);
    expect(counts.red / inRollout).toBeCloseTo(0.3, 1);
    expect(counts.blue / inRollout).toBeCloseTo(0.2, 1);
  });
});
