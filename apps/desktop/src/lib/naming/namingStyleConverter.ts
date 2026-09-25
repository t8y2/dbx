import { detectNamingStyle, type NamingStyle } from "./namingStyleDetector";
import { convertToNamingStyle, SINGLE_IDENTIFIER_PATTERN } from "./namingStyleTransformers";

export interface NamingStyleConversionResult {
  text: string;
  style: NamingStyle;
}

const STYLE_CYCLE: NamingStyle[] = ["camelCase", "PascalCase", "snake_case", "SCREAMING_SNAKE_CASE", "kebab-case"];

function getNextStyle(currentStyle: NamingStyle): NamingStyle {
  const currentIndex = STYLE_CYCLE.indexOf(currentStyle);
  const nextIndex = (currentIndex + 1) % STYLE_CYCLE.length;
  return STYLE_CYCLE[nextIndex];
}

/**
 * Convert to the next naming style in the cycle:
 * camelCase → PascalCase → snake_case → SCREAMING_SNAKE_CASE → kebab-case.
 *
 * Returns the original text unchanged (no-op) when the trimmed content is not
 * a single identifier — e.g. selections containing whitespace, operators,
 * comments, CJK/Cyrillic letters, or line breaks. Whitespace surrounding the
 * identifier is preserved.
 */
export function convertToNextNamingStyle(text: string, currentStyle?: NamingStyle): NamingStyleConversionResult {
  const core = text.trim();
  const detectedStyle = currentStyle ?? detectNamingStyle(core);
  if (!detectedStyle || !SINGLE_IDENTIFIER_PATTERN.test(core)) {
    return { text, style: detectedStyle ?? "camelCase" };
  }

  const nextStyle = getNextStyle(detectedStyle);
  return { text: convertToNamingStyle(text, nextStyle), style: nextStyle };
}
