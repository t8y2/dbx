/**
 * Parse and re-stringify JSON while preserving integer values that exceed
 * Number.MAX_SAFE_INTEGER (2^53 - 1). JavaScript's JSON.parse loses
 * precision on such values (e.g. 87712409002717401 → 87712409002717400),
 * so we replace large integer literals with string placeholders before
 * parsing and restore them after stringifying.
 */
export function safeJsonFormat(text: string, indent?: number): string {
  const MAX_SAFE_INT = String(Number.MAX_SAFE_INTEGER);
  const MIN_SAFE_INT = String(-Number.MAX_SAFE_INTEGER);
  const largeInts = new Map<string, string>();
  const placeholderPrefix = '"__DBX_BIGINT_';

  // Replace large numeric literals (integers or floats with large integer parts)
  // with string placeholders to avoid precision loss.
  // Matches: optional minus, 16+ digits, optional decimal part, followed by
  // a JSON delimiter (comma, ], }, or end-of-string after whitespace).
  const replaced = text.replace(/(-?\d{16,}(?:\.\d+)?)(\s*(?:,|\]|}|$))/g, (_match, digits: string, tail: string) => {
    // Extract the integer part (before any decimal point) for comparison
    const integerPart = digits.split(".")[0];
    const isNegative = integerPart.startsWith("-");
    const absInteger = isNegative ? integerPart.slice(1) : integerPart;
    const threshold = isNegative ? MIN_SAFE_INT.slice(1) : MAX_SAFE_INT;
    if (absInteger.length < threshold.length) return _match;
    if (absInteger.length === threshold.length && absInteger <= threshold) return _match;

    const key = String(largeInts.size);
    largeInts.set(key, digits);
    return `${placeholderPrefix}${key}"${tail}`;
  });

  const parsed = JSON.parse(replaced);
  let result = JSON.stringify(parsed, null, indent ?? undefined);

  for (const [key, digits] of largeInts) {
    result = result.replace(`${placeholderPrefix}${key}"`, digits);
  }

  return result;
}
