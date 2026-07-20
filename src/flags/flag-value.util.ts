import { UnprocessableEntityException } from '@nestjs/common';
import type { FlagType, FlagValue, TargetingRule, Variant } from '../evaluation/engine/types';

export function assertValueMatchesType(type: FlagType, value: unknown, field: string): FlagValue {
  const ok =
    (type === 'boolean' && typeof value === 'boolean') ||
    (type === 'string' && typeof value === 'string') ||
    (type === 'number' && typeof value === 'number' && Number.isFinite(value));
  if (!ok) {
    throw new UnprocessableEntityException({
      message: `${field} must be a ${type} for a ${type} flag`,
      code: 'UNPROCESSABLE',
    });
  }
  return value as FlagValue;
}

export function assertTargetingRules(type: FlagType, rules: unknown): TargetingRule[] {
  if (!Array.isArray(rules)) {
    throw new UnprocessableEntityException({
      message: 'targeting_rules must be an array',
      code: 'UNPROCESSABLE',
    });
  }
  return rules.map((rule, i) => {
    if (
      typeof rule !== 'object' ||
      rule === null ||
      typeof rule.attribute !== 'string' ||
      !['eq', 'in'].includes(rule.operator) ||
      !Array.isArray(rule.values)
    ) {
      throw new UnprocessableEntityException({
        message: `targeting_rules[${i}] must have attribute, operator (eq|in), values[], serve`,
        code: 'UNPROCESSABLE',
      });
    }
    assertValueMatchesType(type, rule.serve, `targeting_rules[${i}].serve`);
    return rule as TargetingRule;
  });
}

export function assertVariants(type: FlagType, variants: unknown): Variant[] | null {
  if (variants === null || variants === undefined) return null;
  if (type !== 'string') {
    throw new UnprocessableEntityException({
      message: 'variants are only supported for string flags',
      code: 'UNPROCESSABLE',
    });
  }
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new UnprocessableEntityException({
      message: 'variants must be a non-empty array',
      code: 'UNPROCESSABLE',
    });
  }
  let total = 0;
  for (const [i, variant] of variants.entries()) {
    if (
      typeof variant !== 'object' ||
      variant === null ||
      typeof variant.value !== 'string' ||
      typeof variant.weight !== 'number' ||
      variant.weight < 0
    ) {
      throw new UnprocessableEntityException({
        message: `variants[${i}] must be {value: string, weight: number >= 0}`,
        code: 'UNPROCESSABLE',
      });
    }
    total += variant.weight;
  }
  if (Math.abs(total - 100) > 1e-9) {
    throw new UnprocessableEntityException({
      message: `variant weights must sum to 100 (got ${total})`,
      code: 'UNPROCESSABLE',
    });
  }
  return variants as Variant[];
}
