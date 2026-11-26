/**
 * Theme helpers shared by every option builder.
 *
 * Kept tiny and separate so each family module has no cross-imports.
 */

import type { AiChartTheme } from "@/lib/ai/richContent/aiChartShared";

export function axisLabelColor(theme: AiChartTheme): string {
  return theme.isDark ? "#aaa" : "#666";
}

export function legendTextStyle(theme: AiChartTheme): { color: string } {
  return { color: theme.isDark ? "#ccc" : "#333" };
}

/** Chart title option, or `undefined` when the spec carries no title. */
export function chartTitleOption(title: string | undefined, theme: AiChartTheme) {
  if (!title) return undefined;
  return { text: title, left: "center" as const, textStyle: { color: theme.isDark ? "#ccc" : "#333", fontSize: 13 } };
}
