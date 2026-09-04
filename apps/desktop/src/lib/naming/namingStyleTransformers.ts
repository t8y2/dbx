import type { NamingStyle } from "./namingStyleDetector";

/**
 * Split text into words based on delimiters and camelCase boundaries
 */
function splitIntoWords(text: string): string[] {
  // Split on underscores, hyphens, or camelCase boundaries
  // Pattern: /[-_]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/
  const parts = text.split(/[-_]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
  return parts.filter((part) => part.length > 0);
}

/**
 * Convert text to specified naming style
 */
export function convertToNamingStyle(text: string, targetStyle: NamingStyle): string {
  const trimmed = text.trim();
  if (!trimmed || !/[a-zA-Z]/.test(trimmed)) return text;

  const words = splitIntoWords(trimmed);
  if (words.length === 0) return text;

  switch (targetStyle) {
    case "camelCase":
      return words.map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())).join("");

    case "PascalCase":
      return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join("");

    case "snake_case":
      return words.map((word) => word.toLowerCase()).join("_");

    case "SCREAMING_SNAKE_CASE":
      return words.map((word) => word.toUpperCase()).join("_");

    case "kebab-case":
      return words.map((word) => word.toLowerCase()).join("-");

    default:
      return text;
  }
}
