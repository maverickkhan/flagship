import { bucket } from './bucket';
import type {
  EvaluableFlag,
  EvaluationContext,
  EvaluationResult,
  FlagValue,
  TargetingRule,
  Variant,
} from './types';

/**
 * Serve semantics (PLAN §3/§5): every flag has an OFF value
 * (flags.default_value) and a per-environment ON value (serve_value).
 *
 *   archived            -> default_value  (excluded from bulk evaluation)
 *   disabled            -> default_value  (the OFF state is operator-defined:
 *                          a boolean whose default_value is true serves true
 *                          when disabled — documented, tested)
 *   targeting match     -> rule.serve     (first match wins)
 *   out of rollout      -> default_value
 *   in rollout+variants -> weighted variant pick (bucket re-scaled)
 *   in rollout          -> serve_value    (ROLLOUT_MATCH if pct < 100,
 *                                          FALLTHROUGH at 100)
 *
 * This makes percentage rollout meaningful for all three flag types:
 * number example — serve 500 to 20% of users, 250 to the rest.
 */
export function evaluateFlag(
  tenantId: string,
  flag: EvaluableFlag,
  userId: string,
  context: EvaluationContext = {},
): EvaluationResult {
  if (flag.status === 'archived') {
    return { value: flag.defaultValue, reason: 'FLAG_ARCHIVED' };
  }

  const env = flag.environment;
  if (!env.enabled) {
    return { value: flag.defaultValue, reason: 'FLAG_DISABLED' };
  }

  const rule = firstMatchingRule(env.targetingRules, context);
  if (rule) {
    return { value: rule.serve, reason: 'TARGETING_MATCH' };
  }

  const pct = env.rolloutPercentage;
  const userBucket = bucket(tenantId, flag.key, userId);
  if (pct < 100 && userBucket >= pct) {
    return { value: flag.defaultValue, reason: 'ROLLOUT_MISS' };
  }

  if (flag.type === 'string' && env.variants && env.variants.length > 0) {
    return {
      value: pickVariant(env.variants, userBucket, pct),
      reason: pct < 100 ? 'ROLLOUT_MATCH' : 'FALLTHROUGH',
    };
  }

  return { value: env.serveValue, reason: pct < 100 ? 'ROLLOUT_MATCH' : 'FALLTHROUGH' };
}

function firstMatchingRule(
  rules: TargetingRule[],
  context: EvaluationContext,
): TargetingRule | undefined {
  return rules.find((rule) => {
    const actual = context[rule.attribute];
    if (actual === undefined) return false;
    switch (rule.operator) {
      case 'eq':
        return rule.values.length > 0 && rule.values[0] === actual;
      case 'in':
        return rule.values.includes(actual);
      default:
        return false;
    }
  });
}

/**
 * Weighted variant selection. The user's bucket is re-scaled from the
 * in-rollout range [0, pct) to [0, 100) and walked across cumulative weights,
 * so variant proportions hold at any rollout percentage and stay sticky for a
 * given user as the rollout grows.
 */
function pickVariant(variants: Variant[], userBucket: number, pct: number): FlagValue {
  const scaled = pct >= 100 ? userBucket : (userBucket / pct) * 100;
  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.weight;
    if (scaled < cumulative) return variant.value;
  }
  return variants[variants.length - 1].value;
}
