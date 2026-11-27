import type { ConnectionConfig } from "@/types/database";

export const CONNECTION_WATERMARK_DEFAULT_COLOR = "#6366f1";
export const CONNECTION_WATERMARK_DEFAULT_FONT_SIZE = 36;
export const CONNECTION_WATERMARK_MIN_FONT_SIZE = 12;
export const CONNECTION_WATERMARK_MAX_FONT_SIZE = 72;
export const CONNECTION_WATERMARK_MAX_TEXT_LENGTH = 48;

interface ConnectionWatermarkAppearance {
  text?: string;
  fontSize?: number;
  color?: string;
}

export function resolveConnectionWatermark(connection: Pick<ConnectionConfig, "name" | "watermark"> | undefined, isProduction: boolean): ConnectionWatermarkAppearance | undefined {
  const watermark = connection?.watermark;
  if (watermark?.mode === "off") return undefined;
  if (watermark?.mode !== "custom") return isProduction ? {} : undefined;

  const fontSize = watermark.font_size ?? CONNECTION_WATERMARK_DEFAULT_FONT_SIZE;
  return {
    text: (watermark.text?.trim() || connection?.name.trim() || "").slice(0, CONNECTION_WATERMARK_MAX_TEXT_LENGTH),
    fontSize: Math.min(CONNECTION_WATERMARK_MAX_FONT_SIZE, Math.max(CONNECTION_WATERMARK_MIN_FONT_SIZE, fontSize)),
    color: watermark.color && /^#[0-9a-f]{6}$/i.test(watermark.color) ? watermark.color.toLowerCase() : CONNECTION_WATERMARK_DEFAULT_COLOR,
  };
}
