export const AI_CONVERSATION_FONT_FAMILY_DEFAULT = "";
export const AI_CONVERSATION_FONT_SIZE_DEFAULT = 12;
export const AI_CONVERSATION_FONT_SIZE_MIN = 10;
export const AI_CONVERSATION_FONT_SIZE_MAX = 24;

const AI_CONVERSATION_FONT_FAMILY_MAX_LENGTH = 512;
const AI_CODE_FONT_SIZE_MIN = 11;

export interface AiConversationTypography {
  fontFamily: string;
  fontSize: number;
}

export function normalizeAiConversationFontFamily(value: unknown): string {
  if (typeof value !== "string") return AI_CONVERSATION_FONT_FAMILY_DEFAULT;
  return value.trim().slice(0, AI_CONVERSATION_FONT_FAMILY_MAX_LENGTH);
}

export function aiConversationFontFamilyForName(name: string): string {
  return `'${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}', sans-serif`;
}

export function normalizeAiConversationFontFamilyInput(value: string): string {
  const normalized = normalizeAiConversationFontFamily(value);
  if (!normalized || normalized.includes(",") || normalized.includes("'") || normalized.includes('"')) return normalized;
  return aiConversationFontFamilyForName(normalized);
}

export function normalizeAiConversationFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return AI_CONVERSATION_FONT_SIZE_DEFAULT;
  return Math.min(AI_CONVERSATION_FONT_SIZE_MAX, Math.max(AI_CONVERSATION_FONT_SIZE_MIN, Math.round(value)));
}

export function normalizeAiConversationTypography(value: Partial<AiConversationTypography> | null | undefined): AiConversationTypography {
  return {
    fontFamily: normalizeAiConversationFontFamily(value?.fontFamily),
    fontSize: normalizeAiConversationFontSize(value?.fontSize),
  };
}

export function aiConversationTypographyCssVariables(value: Partial<AiConversationTypography> | null | undefined): Record<string, string> {
  const typography = normalizeAiConversationTypography(value);
  const variables: Record<string, string> = {
    "--dbx-ai-content-font-size": `${typography.fontSize}px`,
    "--dbx-ai-code-font-size": `${Math.max(AI_CODE_FONT_SIZE_MIN, typography.fontSize)}px`,
    "--dbx-ai-inline-code-font-size": `${Math.max(AI_CODE_FONT_SIZE_MIN, typography.fontSize - 1)}px`,
  };
  if (typography.fontFamily) variables["--dbx-ai-content-font-family"] = typography.fontFamily;
  return variables;
}
