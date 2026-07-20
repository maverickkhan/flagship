import { UnprocessableEntityException } from '@nestjs/common';
import { assertTargetingRules, assertValueMatchesType, assertVariants } from './flag-value.util';

describe('assertValueMatchesType', () => {
  it('accepts matching primitives', () => {
    expect(assertValueMatchesType('boolean', true, 'v')).toBe(true);
    expect(assertValueMatchesType('string', 'x', 'v')).toBe('x');
    expect(assertValueMatchesType('number', 3.5, 'v')).toBe(3.5);
  });

  it.each([
    ['boolean', 'true'],
    ['boolean', 1],
    ['string', 5],
    ['number', '5'],
    ['number', NaN],
    ['number', null],
    ['boolean', undefined],
  ] as const)('rejects %s flag with value %p', (type, value) => {
    expect(() => assertValueMatchesType(type, value, 'v')).toThrow(UnprocessableEntityException);
  });
});

describe('assertTargetingRules', () => {
  it('accepts well-formed rules with type-matching serve', () => {
    const rules = assertTargetingRules('string', [
      { attribute: 'country', operator: 'in', values: ['PK'], serve: 'green' },
    ]);
    expect(rules).toHaveLength(1);
  });

  it.each([
    ['not an array', {}],
    ['missing attribute', [{ operator: 'eq', values: [], serve: 'x' }]],
    ['bad operator', [{ attribute: 'a', operator: 'gt', values: [1], serve: 'x' }]],
    ['values not array', [{ attribute: 'a', operator: 'eq', values: 'x', serve: 'x' }]],
    ['serve type mismatch', [{ attribute: 'a', operator: 'eq', values: ['x'], serve: 5 }]],
  ])('rejects %s', (_label, rules) => {
    expect(() => assertTargetingRules('string', rules)).toThrow(UnprocessableEntityException);
  });
});

describe('assertVariants', () => {
  it('accepts weights summing to 100 on string flags', () => {
    const variants = assertVariants('string', [
      { value: 'a', weight: 60 },
      { value: 'b', weight: 40 },
    ]);
    expect(variants).toHaveLength(2);
  });

  it('passes through null/undefined', () => {
    expect(assertVariants('string', null)).toBeNull();
    expect(assertVariants('string', undefined)).toBeNull();
  });

  it.each([
    ['non-string flag', 'boolean', [{ value: 'a', weight: 100 }]],
    ['empty array', 'string', []],
    [
      'weights over 100',
      'string',
      [
        { value: 'a', weight: 60 },
        { value: 'b', weight: 60 },
      ],
    ],
    ['weights under 100', 'string', [{ value: 'a', weight: 10 }]],
    [
      'negative weight',
      'string',
      [
        { value: 'a', weight: -10 },
        { value: 'b', weight: 110 },
      ],
    ],
    ['non-string value', 'string', [{ value: 5, weight: 100 }]],
  ] as const)('rejects %s', (_label, type, variants) => {
    expect(() => assertVariants(type as any, variants)).toThrow(UnprocessableEntityException);
  });
});
