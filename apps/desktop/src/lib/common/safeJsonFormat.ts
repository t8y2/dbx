const LOSSLESS_JSON_NUMBER = Symbol("DBX lossless JSON number");

export interface LosslessJsonNumber {
  readonly [LOSSLESS_JSON_NUMBER]: true;
  readonly raw: string;
}

interface ProtectedJsonNumbers {
  text: string;
  numbers: Map<string, string>;
}

const MAX_SAFE_INTEGER_TEXT = String(Number.MAX_SAFE_INTEGER);

export function isLosslessJsonNumber(value: unknown): value is LosslessJsonNumber {
  return typeof value === "object" && value !== null && (value as Partial<LosslessJsonNumber>)[LOSSLESS_JSON_NUMBER] === true && typeof (value as Partial<LosslessJsonNumber>).raw === "string";
}

/**
 * Parses JSON while retaining numeric literals that JavaScript cannot safely
 * represent exactly. Callers can render these values without adding quotes.
 */
export function parseJsonPreservingLargeNumbers(text: string): unknown {
  const protectedJson = protectLargeJsonNumbers(text);
  const parsed = JSON.parse(protectedJson.text);
  return restoreLosslessNumbers(parsed, protectedJson.numbers);
}

/**
 * Parse and re-stringify JSON while preserving numeric literals whose integer
 * parts exceed Number.MAX_SAFE_INTEGER (2^53 - 1), plus decimal and exponent
 * forms that JavaScript may round or turn into Infinity.
 */
export function safeJsonFormat(text: string, indent?: number): string {
  const protectedJson = protectLargeJsonNumbers(text);
  const parsed = JSON.parse(protectedJson.text);
  let result = JSON.stringify(parsed, null, indent ?? undefined);

  for (const [placeholder, raw] of protectedJson.numbers) {
    result = result.replaceAll(JSON.stringify(placeholder), raw);
  }

  return result;
}

function protectLargeJsonNumbers(text: string): ProtectedJsonNumbers {
  let placeholderPrefix = "__DBX_LOSSLESS_NUMBER_";
  while (text.includes(placeholderPrefix)) placeholderPrefix += "_";

  const numbers = new Map<string, string>();
  let output = "";
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      const stringEnd = findJsonStringEnd(text, index);
      output += text.slice(index, stringEnd);
      index = stringEnd;
      continue;
    }

    const numberMatch = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (numberMatch) {
      const raw = numberMatch[0];
      if (shouldPreserveJsonNumber(raw)) {
        // A quoted placeholder lets the native parser validate the rest of the JSON.
        const placeholder = `${placeholderPrefix}${numbers.size}__`;
        numbers.set(placeholder, raw);
        output += JSON.stringify(placeholder);
      } else {
        output += raw;
      }
      index += raw.length;
      continue;
    }

    output += character;
    index += 1;
  }

  return { text: output, numbers };
}

function findJsonStringEnd(text: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      return index + 1;
    }
  }
  return text.length;
}

function shouldPreserveJsonNumber(raw: string): boolean {
  // Keep fractional/exponent forms verbatim. Even when a particular value is
  // representable today, parsing it through Number can change its precision or
  // spelling before the JSON viewer renders it.
  if (raw.includes(".") || raw.includes("e") || raw.includes("E") || raw === "-0") return true;

  const unsigned = raw.startsWith("-") ? raw.slice(1) : raw;
  const integerPart = unsigned.split(/[.eE]/, 1)[0];
  const normalized = integerPart.replace(/^0+(?=\d)/, "");
  return normalized.length > MAX_SAFE_INTEGER_TEXT.length || (normalized.length === MAX_SAFE_INTEGER_TEXT.length && normalized > MAX_SAFE_INTEGER_TEXT);
}

function restoreLosslessNumbers(value: unknown, numbers: Map<string, string>): unknown {
  if (typeof value === "string") {
    const raw = numbers.get(value);
    return raw === undefined ? value : ({ [LOSSLESS_JSON_NUMBER]: true, raw } satisfies LosslessJsonNumber);
  }
  if (Array.isArray(value)) return value.map((item) => restoreLosslessNumbers(item, numbers));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreLosslessNumbers(item, numbers)]));
  }
  return value;
}
