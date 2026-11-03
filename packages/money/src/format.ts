import { type Paise, toRupeeString } from './paise.js';

/**
 * Display formatting. Money is formatted exactly once, at the edge, from the
 * exact integer -- the grouping is applied to the whole-rupee part (a safe
 * integer) and the two paise digits are appended as text, so no float ever
 * touches the displayed value.
 */

export interface FormatOptions {
  /** Include the ₹ symbol. Default true. */
  symbol?: boolean;
  /** Hide ".00" on whole-rupee amounts. Default false -- bills show both digits. */
  compact?: boolean;
  /** Locale used for digit grouping. Default 'en-IN' (lakh/crore grouping). */
  locale?: string;
}

const groupers = new Map<string, Intl.NumberFormat>();

function groupInteger(value: number, locale: string): string {
  let grouper = groupers.get(locale);
  if (!grouper) {
    grouper = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 });
    groupers.set(locale, grouper);
  }
  return grouper.format(value);
}

/** `formatPaise(123450 as Paise)` -> "₹1,234.50" */
export function formatPaise(value: Paise, options: FormatOptions = {}): string {
  const { symbol = true, compact = false, locale = 'en-IN' } = options;

  const decimal = toRupeeString(value);
  const negative = decimal.startsWith('-');
  const [whole = '0', fraction = '00'] = (negative ? decimal.slice(1) : decimal).split('.');

  const grouped = groupInteger(Number(whole), locale);
  const showFraction = !(compact && fraction === '00');

  return [negative ? '-' : '', symbol ? '₹' : '', grouped, showFraction ? `.${fraction}` : ''].join(
    '',
  );
}

/** Signed form for adjustments: "+₹0.40" / "-₹0.60". Used for the round-off line. */
export function formatPaiseSigned(value: Paise, options: FormatOptions = {}): string {
  const formatted = formatPaise(value, options);
  return value > 0 ? `+${formatted}` : formatted;
}
