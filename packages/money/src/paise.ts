/**
 * Integer-paise money primitives.
 *
 * Every monetary value in this system is an integer number of paise (1/100 of
 * a rupee) carried in a branded `Paise` type. There is no float money anywhere:
 * a float cannot represent 0.07 exactly, and a POS that is off by a paise on a
 * tax line produces an invoice that does not reconcile -- which, with GST on
 * it, is a legal document that is wrong.
 *
 * Rounding convention: **half away from zero** (the ordinary commercial
 * rounding Indian GST computation assumes), applied at exactly the points the
 * pricing engine declares -- never implicitly.
 */

/** An integer number of paise. 100 paise = ₹1. */
export type Paise = number & { readonly __brand: 'Paise' };

/** Basis points: 1 bps = 0.01%. A 5% GST rate is 500 bps, 18% is 1800 bps. */
export type Bps = number & { readonly __brand: 'Bps' };

/**
 * Hard ceiling on a single money value: ₹10,000,000,000 (one thousand crore)
 * in paise. Comfortably above any restaurant bill, and low enough that
 * `value * 10_000` in a basis-point multiplication stays inside
 * Number.MAX_SAFE_INTEGER.
 */
export const MAX_PAISE = 1_000_000_000_000;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export const ZERO = 0 as Paise;

/** Assert an arbitrary number is a usable paise value and brand it. */
export function paise(value: number): Paise {
  if (!Number.isInteger(value)) {
    throw new MoneyError(
      `Money must be an integer number of paise, received ${value}. ` +
        'If this came from a decimal rupee string, use fromRupees().',
    );
  }
  if (Math.abs(value) > MAX_PAISE) {
    throw new MoneyError(`Money value ${value} exceeds the ±${MAX_PAISE} paise limit.`);
  }
  // Normalise negative zero. `-0 === 0` is true so arithmetic is unaffected,
  // but `Object.is(-0, 0)` is false -- which quietly breaks equality checks,
  // Map keys and snapshot comparisons, and would print a refund line as
  // "-₹0.00". Every operation here funnels through paise(), so collapsing it at
  // this one point makes a -0 Paise impossible to construct.
  return (value === 0 ? 0 : value) as Paise;
}

/** True when the value is a valid paise integer. Never throws. */
export function isPaise(value: unknown): value is Paise {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= MAX_PAISE;
}

export const bps = (value: number): Bps => {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`Basis points must be an integer, received ${value}.`);
  }
  if (value < 0 || value > 1_000_000) {
    throw new MoneyError(`Basis points ${value} outside the supported 0..1000000 range.`);
  }
  return value as Bps;
};

const RUPEE_STRING = /^(-)?(\d{1,13})(?:\.(\d{1,2}))?$/;

/**
 * Parse a decimal rupee *string* into exact paise -- the only safe way to
 * accept money typed by a human or stored in a CSV. Deliberately string-only:
 * accepting a float here would reintroduce the problem this module exists to
 * prevent.
 *
 * `fromRupees('1234.5')` -> 123450 paise
 */
export function fromRupees(value: string): Paise {
  const match = RUPEE_STRING.exec(value.trim());
  if (!match) {
    throw new MoneyError(
      `"${value}" is not a rupee amount. Expected digits with at most two decimal places, e.g. "249.50".`,
    );
  }
  const [, sign, whole, fraction = ''] = match;
  const fractionPaise = Number(fraction.padEnd(2, '0'));
  const magnitude = Number(whole) * 100 + fractionPaise;
  return paise(sign === '-' ? -magnitude : magnitude);
}

/** Exact decimal-rupee string. Round-trips with fromRupees(). */
export function toRupeeString(value: Paise): string {
  const sign = value < 0 ? '-' : '';
  const magnitude = Math.abs(value);
  const whole = Math.trunc(magnitude / 100);
  const remainder = magnitude - whole * 100;
  return `${sign}${whole}.${String(remainder).padStart(2, '0')}`;
}

export function add(...values: Paise[]): Paise {
  let acc = 0;
  for (const value of values) acc += value;
  return paise(acc);
}

export const sum = (values: readonly Paise[]): Paise => add(...values);

export function subtract(a: Paise, b: Paise): Paise {
  return paise(a - b);
}

export function negate(value: Paise): Paise {
  return paise(-value);
}

export function absolute(value: Paise): Paise {
  return paise(Math.abs(value));
}

/** Multiply by an integer quantity. Exact -- no rounding involved. */
export function multiplyQty(value: Paise, quantity: number): Paise {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new MoneyError(`Quantity must be a non-negative integer, received ${quantity}.`);
  }
  return paise(value * quantity);
}

/** Round a rational `numerator/denominator` half away from zero. */
function divideRound(numerator: number, denominator: number): number {
  if (denominator === 0) throw new MoneyError('Division by zero in money arithmetic.');
  if (!Number.isSafeInteger(numerator)) {
    throw new MoneyError(
      `Money arithmetic overflowed the safe integer range (${numerator}). ` +
        'Split the calculation or lower the value.',
    );
  }
  const sign = numerator < 0 ? -1 : 1;
  const magnitude = Math.abs(numerator);
  return sign * Math.floor((magnitude * 2 + denominator) / (denominator * 2));
}

/**
 * Apply a basis-point rate, rounded half away from zero.
 * `applyBps(10000 paise, 1800 bps)` -> 1800 paise (18% of ₹100 = ₹18).
 */
export function applyBps(value: Paise, rate: Bps): Paise {
  return paise(divideRound(value * rate, 10_000));
}

/**
 * Back out the tax component of a **tax-inclusive** price.
 * A ₹100 menu price at 5% GST contains ₹4.76 of tax, not ₹5.
 * `tax = gross * rate / (10000 + rate)`
 */
export function taxFromInclusive(gross: Paise, rate: Bps): Paise {
  return paise(divideRound(gross * rate, 10_000 + rate));
}

/** The net (pre-tax) part of a tax-inclusive price. Net + tax === gross, always. */
export function netFromInclusive(gross: Paise, rate: Bps): Paise {
  return subtract(gross, taxFromInclusive(gross, rate));
}

/**
 * Round to the nearest whole rupee, returning both the rounded value and the
 * adjustment. Indian invoices print that adjustment as an explicit "Round off"
 * line, so we return it rather than discarding it.
 */
export function roundToRupee(value: Paise): { rounded: Paise; delta: Paise } {
  const rounded = paise(divideRound(value, 100) * 100);
  return { rounded, delta: subtract(rounded, value) };
}

/**
 * Split an amount across weights so that the parts sum **exactly** back to the
 * amount -- the largest-remainder method.
 *
 * This is how an order-level discount is prorated onto lines. Naive rounding
 * loses or invents paise: ₹10 across three equal lines is 333+333+333 = 999,
 * one paise short of the discount actually granted. The remainder is handed to
 * the largest fractional parts, so the books balance.
 */
export function splitByWeights(amount: Paise, weights: readonly number[]): Paise[] {
  if (weights.length === 0) return [];
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new MoneyError('Split weights must be finite and non-negative.');
  }

  const weightSum = weights.reduce((acc, w) => acc + w, 0);
  if (weightSum === 0) {
    // Nothing to weigh by: give it all to the first bucket so the sum still holds.
    return weights.map((_, index) => (index === 0 ? amount : ZERO));
  }

  const sign = amount < 0 ? -1 : 1;
  const magnitude = Math.abs(amount);

  const exact = weights.map((w) => (magnitude * w) / weightSum);
  const floored = exact.map((value) => Math.floor(value));
  let remainder = magnitude - floored.reduce((acc, value) => acc + value, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  const parts = [...floored];
  for (const { index } of order) {
    if (remainder <= 0) break;
    parts[index] = (parts[index] ?? 0) + 1;
    remainder -= 1;
  }

  return parts.map((part) => paise(sign * part));
}

/** Split evenly across `count` buckets, remainder-safe. */
export function splitEvenly(amount: Paise, count: number): Paise[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new MoneyError(`Split count must be a positive integer, received ${count}.`);
  }
  return splitByWeights(amount, new Array<number>(count).fill(1));
}

export const isZero = (value: Paise): boolean => value === 0;
export const isNegative = (value: Paise): boolean => value < 0;
export const isPositive = (value: Paise): boolean => value > 0;

export function compare(a: Paise, b: Paise): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export const equals = (a: Paise, b: Paise): boolean => a === b;
export const max = (...values: Paise[]): Paise => paise(Math.max(...values));
export const min = (...values: Paise[]): Paise => paise(Math.min(...values));

/** Clamp to a range -- used for capped discounts. */
export function clamp(value: Paise, lower: Paise, upper: Paise): Paise {
  if (lower > upper) throw new MoneyError('clamp() called with lower bound above upper bound.');
  return paise(Math.min(Math.max(value, lower), upper));
}
