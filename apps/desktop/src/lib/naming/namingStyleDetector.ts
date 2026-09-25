export type NamingStyle = "camelCase" | "PascalCase" | "snake_case" | "SCREAMING_SNAKE_CASE" | "kebab-case";

export function detectNamingStyle(text: string): NamingStyle | null {
  const trimmed = text.trim();
  if (!trimmed || !/[a-zA-Z]/.test(trimmed)) return null;

  // Priority order matters
  if (trimmed.includes("-")) return "kebab-case";
  if (trimmed.includes("_")) {
    return trimmed === trimmed.toUpperCase() ? "SCREAMING_SNAKE_CASE" : "snake_case";
  }
  if (/^[A-Z]/.test(trimmed)) return "PascalCase";
  return "camelCase";
}
