import { cssFontFamilyForName, FONT_FAMILIES, LEGACY_PRESET_FONT_MAP, readableFontFamily } from "@/lib/app/appFonts";
import { listSystemFonts } from "@/lib/backend/api";

let cachedSystemFontNames: string[] | null = null;
let pendingSystemFontNames: Promise<string[]> | null = null;

const presetFontLabels = new Map<string, string>([
  ...FONT_FAMILIES.map((font) => [font.value, font.label] as const),
  ...Object.entries(LEGACY_PRESET_FONT_MAP).map(([legacyVal, newVal]) => {
    const label = FONT_FAMILIES.find((f) => f.value === newVal)?.label ?? "System Monospace";
    return [legacyVal, label] as const;
  }),
]);
const presetFontValues = new Set<string>([...FONT_FAMILIES.map((font) => font.value), ...Object.keys(LEGACY_PRESET_FONT_MAP)]);

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
