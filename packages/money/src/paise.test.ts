import { describe, expect, it } from 'vitest';

import { formatPaise, formatPaiseSigned } from './format.js';
import {
  add,
  applyBps,
  bps,
  clamp,
  fromRupees,
  MAX_PAISE,
  MoneyError,
  multiplyQty,
  netFromInclusive,
  paise,
  roundToRupee,
  splitByWeights,
  splitEvenly,
  subtract,
  sum,
  taxFromInclusive,
  toRupeeString,
  ZERO,
} from './paise.js';

describe('paise()', () => {
  it('brands integers', () => {
    expect(paise(1999)).toBe(1999);
    expect(paise(0)).toBe(0);
    expect(paise(-500)).toBe(-500);
  });

  it('rejects fractional paise, pointing at fromRupees', () => {
    expect(() => paise(19.99)).toThrow(MoneyError);
    expect(() => paise(19.99)).toThrow(/fromRupees/);
  });

  it('rejects values beyond the limit', () => {
    expect(() => paise(MAX_PAISE + 1)).toThrow(/limit/);
  });
});

describe('fromRupees()', () => {
  it.each([
    ['0', 0],
    ['1', 100],
    ['1.5', 150],
    ['1.50', 150],
    ['0.07', 7],
    ['249.99', 24999],
    ['1234.5', 123450],
    ['-45.25', -4525],
    [' 99.90 ', 9990],
  ])('parses %s to %d paise', (input, expected) => {
    expect(fromRupees(input)).toBe(expected);
  });

  it('is exact where float parsing is not', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in floats. Not here.
    expect(add(fromRupees('0.10'), fromRupees('0.20'))).toBe(fromRupees('0.30'));
    // 8.7 * 100 === 869.9999999999999 under IEEE 754.
    expect(fromRupees('8.70')).toBe(870);
  });

  it.each(['', 'abc', '1.234', '1,234.00', '₹100', '1e3', '.5', '--5'])('rejects %s', (input) => {
    expect(() => fromRupees(input)).toThrow(MoneyError);
  });

  it('round-trips through toRupeeString', () => {
    for (const value of ['0.00', '0.05', '7.00', '1234.56', '-89.10']) {
      expect(toRupeeString(fromRupees(value))).toBe(value);
    }
  });
});

describe('arithmetic', () => {
  it('adds and sums', () => {
    expect(add(paise(100), paise(250), paise(3))).toBe(353);
    expect(sum([paise(100), paise(250)])).toBe(350);
    expect(sum([])).toBe(ZERO);
  });

  it('subtracts into the negative', () => {
    expect(subtract(paise(100), paise(250))).toBe(-150);
  });

  it('multiplies by integer quantity exactly', () => {
    expect(multiplyQty(fromRupees('249.99'), 3)).toBe(74997);
  });

  it('refuses a fractional quantity', () => {
    expect(() => multiplyQty(paise(100), 1.5)).toThrow(/non-negative integer/);
  });

  it('clamps for capped discounts', () => {
    expect(clamp(paise(900), ZERO, paise(500))).toBe(500);
    expect(clamp(paise(-50), ZERO, paise(500))).toBe(0);
  });
});

describe('applyBps()', () => {
  it.each([
    ['100.00', 500, 500], // 5% GST on ₹100 = ₹5.00
    ['100.00', 1800, 1800], // 18% GST on ₹100 = ₹18.00
    ['249.00', 500, 1245], // 5% of ₹249 = ₹12.45 exactly
    ['249.50', 1800, 4491], // 18% of ₹249.50 = ₹44.91
    ['33.33', 500, 167], // ₹1.6665 -> ₹1.67, half away from zero
    ['0.10', 500, 1], // ₹0.005 -> ₹0.01, rounded up rather than truncated
    ['0.01', 500, 0], // ₹0.0005 -> ₹0.00; below half a paise there is no tax
  ])('%s at %i bps -> %i paise', (amount, rate, expected) => {
    expect(applyBps(fromRupees(amount), bps(rate))).toBe(expected);
  });

  it('rounds half away from zero on both signs', () => {
    expect(applyBps(paise(1), bps(5000))).toBe(1); // 0.5 -> 1
    expect(applyBps(paise(-1), bps(5000))).toBe(-1); // -0.5 -> -1
  });

  it('is linear in quantity when applied to the line total, as the engine does', () => {
    const unit = fromRupees('33.33');
    const lineTax = applyBps(multiplyQty(unit, 3), bps(500));
    expect(lineTax).toBe(500); // 5% of ₹99.99 = ₹5.00 (₹4.9995 rounded)
    // Taxing each unit and adding would give ₹5.01 -- which is why the engine
    // taxes the line, never the unit. This test pins that difference down.
    expect(applyBps(unit, bps(500)) * 3).toBe(501);
  });
});

describe('inclusive tax back-calculation', () => {
  it('extracts 5% GST from a ₹100 inclusive menu price', () => {
    const gross = fromRupees('100.00');
    expect(taxFromInclusive(gross, bps(500))).toBe(476); // ₹4.76, not ₹5.00
    expect(netFromInclusive(gross, bps(500))).toBe(9524);
  });

  it('keeps net + tax === gross for every rate and price', () => {
    for (const rate of [500, 1200, 1800]) {
      for (let gross = 1; gross <= 2000; gross += 7) {
        const value = paise(gross);
        const tax = taxFromInclusive(value, bps(rate));
        const net = netFromInclusive(value, bps(rate));
        expect(add(net, tax)).toBe(value);
      }
    }
  });
});

describe('roundToRupee()', () => {
  it.each([
    ['249.40', 24900, -40],
    ['249.60', 25000, 40],
    ['249.50', 25000, 50],
    ['250.00', 25000, 0],
    ['-249.60', -25000, -40],
  ])('%s rounds to %i with delta %i', (amount, rounded, delta) => {
    expect(roundToRupee(fromRupees(amount))).toEqual({ rounded, delta });
  });

  it('never loses the adjustment', () => {
    for (let value = 0; value < 500; value += 1) {
      const { rounded, delta } = roundToRupee(paise(value));
      expect(subtract(rounded, delta)).toBe(value);
    }
  });
});

describe('splitByWeights()', () => {
  it('prorates a discount so the parts sum exactly to the discount', () => {
    const parts = splitEvenly(fromRupees('10.00'), 3);
    expect(parts).toEqual([334, 333, 333]);
    expect(sum(parts)).toBe(1000); // naive rounding would give 999
  });

  it('weights by line value', () => {
    const parts = splitByWeights(fromRupees('100.00'), [1000, 2000, 3000]);
    expect(parts).toEqual([1667, 3333, 5000]);
    expect(sum(parts)).toBe(10000);
  });

  it('holds the sum invariant across many awkward splits', () => {
    for (let amount = 0; amount <= 997; amount += 1) {
      for (const weights of [
        [1, 1, 1],
        [1, 2, 7],
        [5, 5],
        [3, 0, 3],
        [1, 1, 1, 1, 1, 1, 1],
      ]) {
        const parts = splitByWeights(paise(amount), weights);
        expect(sum(parts)).toBe(amount);
        expect(parts).toHaveLength(weights.length);
      }
    }
  });

  it('handles negative amounts (refunds) without losing a paise', () => {
    const parts = splitEvenly(fromRupees('-10.00'), 3);
    expect(sum(parts)).toBe(-1000);
  });

  it('puts everything in the first bucket when all weights are zero', () => {
    expect(splitByWeights(paise(500), [0, 0])).toEqual([500, 0]);
  });

  it('returns nothing for no buckets', () => {
    expect(splitByWeights(paise(500), [])).toEqual([]);
  });

  it('rejects a non-positive bucket count', () => {
    expect(() => splitEvenly(paise(100), 0)).toThrow(/positive integer/);
  });
});

describe('formatting', () => {
  it.each([
    [0, '₹0.00'],
    [7, '₹0.07'],
    [123450, '₹1,234.50'],
    [10000000, '₹1,00,000.00'], // Indian lakh grouping
    [-4525, '-₹45.25'],
  ])('formats %i as %s', (value, expected) => {
    expect(formatPaise(paise(value))).toBe(expected);
  });

  it('drops the symbol and the trailing zeros on request', () => {
    expect(formatPaise(paise(25000), { symbol: false })).toBe('250.00');
    expect(formatPaise(paise(25000), { compact: true })).toBe('₹250');
    expect(formatPaise(paise(25050), { compact: true })).toBe('₹250.50');
  });

  it('signs the round-off line', () => {
    expect(formatPaiseSigned(paise(40))).toBe('+₹0.40');
    expect(formatPaiseSigned(paise(-60))).toBe('-₹0.60');
    expect(formatPaiseSigned(ZERO)).toBe('₹0.00');
  });
});
