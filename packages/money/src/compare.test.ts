import { describe, expect, it } from 'vitest';

import { formatPaise } from './format.js';
import {
  absolute,
  applyBps,
  bps,
  compare,
  equals,
  fromRupees,
  multiplyQty,
  subtract,
  isNegative,
  isPaise,
  isPositive,
  isZero,
  MAX_PAISE,
  max,
  min,
  MoneyError,
  negate,
  paise,
  ZERO,
} from './paise.js';

describe('sign helpers', () => {
  it('negates, which is how a refund line is produced', () => {
    expect(negate(fromRupees('249.50'))).toBe(-24950);
    expect(negate(paise(-24950))).toBe(24950);
    expect(negate(ZERO)).toBe(0);
  });

  it('never produces negative zero', () => {
    // -0 compares equal to 0 with ===, but not with Object.is, so it leaks
    // into test failures, Map keys and a "-₹0.00" refund line.
    for (const value of [
      negate(ZERO),
      absolute(ZERO),
      paise(-0),
      fromRupees('-0.00'),
      multiplyQty(fromRupees('-0.00'), 3),
      applyBps(ZERO, bps(1800)),
      subtract(ZERO, ZERO),
    ]) {
      expect(Object.is(value, -0)).toBe(false);
      expect(Object.is(value, 0)).toBe(true);
    }

    expect(formatPaise(negate(ZERO))).toBe('₹0.00');
  });

  it('takes an absolute value', () => {
    expect(absolute(paise(-4525))).toBe(4525);
    expect(absolute(paise(4525))).toBe(4525);
  });

  it('classifies zero, positive and negative', () => {
    expect(isZero(ZERO)).toBe(true);
    expect(isZero(paise(1))).toBe(false);

    expect(isPositive(paise(1))).toBe(true);
    expect(isPositive(ZERO)).toBe(false);
    expect(isPositive(paise(-1))).toBe(false);

    expect(isNegative(paise(-1))).toBe(true);
    expect(isNegative(ZERO)).toBe(false);
  });
});

describe('comparison', () => {
  it('orders two amounts', () => {
    expect(compare(paise(100), paise(250))).toBe(-1);
    expect(compare(paise(250), paise(100))).toBe(1);
    expect(compare(paise(100), paise(100))).toBe(0);
  });

  it('sorts a list of amounts correctly', () => {
    const amounts = [paise(500), paise(-100), ZERO, paise(24950), paise(7)];
    expect([...amounts].sort(compare)).toEqual([-100, 0, 7, 500, 24950]);
  });

  it('compares for equality', () => {
    expect(equals(fromRupees('12.00'), paise(1200))).toBe(true);
    expect(equals(paise(1200), paise(1201))).toBe(false);
  });

  it('picks the larger and smaller', () => {
    expect(max(paise(100), paise(250), paise(-900))).toBe(250);
    expect(min(paise(100), paise(250), paise(-900))).toBe(-900);
  });
});

describe('isPaise()', () => {
  it.each([
    [0, true],
    [24950, true],
    [-4525, true],
    [MAX_PAISE, true],
    [19.99, false],
    [MAX_PAISE + 1, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    ['24950', false],
    [null, false],
    [undefined, false],
    [{}, false],
  ])('%s -> %s', (value, expected) => {
    expect(isPaise(value)).toBe(expected);
  });

  it('never throws, so it is safe on untrusted input', () => {
    expect(() => isPaise('nonsense')).not.toThrow();
  });
});

describe('bps()', () => {
  it('accepts the GST slabs', () => {
    expect(bps(0)).toBe(0);
    expect(bps(500)).toBe(500);
    expect(bps(1200)).toBe(1200);
    expect(bps(1800)).toBe(1800);
  });

  it.each([
    ['a fraction', 5.5],
    ['a negative rate', -500],
    ['an absurd rate', 1_000_001],
  ])('rejects %s', (_label, value) => {
    expect(() => bps(value)).toThrow(MoneyError);
  });
});
