/** Parse a non-negative safe integer from user input; rejects decimals and unsafe magnitudes. */
export function parseNonNegativeSafeInteger(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}
