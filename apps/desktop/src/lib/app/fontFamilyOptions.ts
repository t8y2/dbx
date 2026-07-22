import { cssFontFamilyForName, FONT_FAMILIES, readableFontFamily } from "@/lib/app/appFonts";
import { listSystemFonts } from "@/lib/backend/api";

let cachedSystemFontNames: string[] | null = null;
let pendingSystemFontNames: Promise<string[]> | null = null;

const presetFontLabels = new Map(FONT_FAMILIES.map((font) => [font.value, font.label]));
const presetFontValues = new Set(FONT_FAMILIES.map((font) => font.value));

export function buildFontFamilyOptions(systemFontNames: readonly string[], selectedValues: readonly string[] = [], leadingValues: readonly string[] = []): string[] {
  return [...new Set([...leadingValues, ...FONT_FAMILIES.map((font) => font.value), ...systemFontNames.map(cssFontFamilyForName), ...selectedValues.filter(Boolean)])];
}

export function displayFontFamily(value: string): string {
  return presetFontLabels.get(value) ?? readableFontFamily(value);
}

export function isPresetFontFamily(value: string): boolean {
  return presetFontValues.has(value);
}

export async function loadSystemFontNames(): Promise<string[]> {
  if (cachedSystemFontNames) return cachedSystemFontNames;
  pendingSystemFontNames ??= listSystemFonts().finally(() => {
    pendingSystemFontNames = null;
  });
  cachedSystemFontNames = await pendingSystemFontNames;
  return cachedSystemFontNames;
}
