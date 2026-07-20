export type FlagType = 'boolean' | 'string' | 'number';
export type FlagValue = boolean | string | number;

export type EvaluationReason =
  | 'FLAG_ARCHIVED'
  | 'FLAG_DISABLED'
  | 'TARGETING_MATCH'
  | 'ROLLOUT_MATCH'
  | 'ROLLOUT_MISS'
  | 'FALLTHROUGH';

export interface TargetingRule {
  attribute: string;
  operator: 'eq' | 'in';
  values: FlagValue[];
  serve: FlagValue;
}

export interface Variant {
  value: string;
  /** Percentage weight; all weights across a variant list must sum to 100. */
  weight: number;
}

export interface EvaluableFlag {
  key: string;
  type: FlagType;
  status: 'active' | 'archived';
  defaultValue: FlagValue;
  environment: {
    enabled: boolean;
    serveValue: FlagValue;
    rolloutPercentage: number;
    targetingRules: TargetingRule[];
    variants: Variant[] | null;
  };
}

export interface EvaluationResult {
  value: FlagValue;
  reason: EvaluationReason;
}

export type EvaluationContext = Record<string, FlagValue>;
