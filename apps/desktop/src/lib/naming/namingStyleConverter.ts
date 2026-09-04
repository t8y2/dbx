import { detectNamingStyle, type NamingStyle } from "./namingStyleDetector";
import { convertToNamingStyle } from "./namingStyleTransformers";

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

export function convertToNextNamingStyle(text: string, currentStyle?: NamingStyle): NamingStyleConversionResult {
  const trimmed = text.trim();
  if (!trimmed || !/[a-zA-Z]/.test(trimmed)) {
    return { text, style: currentStyle || "camelCase" };
  }

  const detectedStyle = currentStyle || detectNamingStyle(trimmed);
  if (!detectedStyle) {
    return { text, style: "camelCase" };
  }

  const nextStyle = getNextStyle(detectedStyle);
  const convertedText = convertToNamingStyle(trimmed, nextStyle);

  return {
    text: convertedText,
    style: nextStyle,
  };
}
