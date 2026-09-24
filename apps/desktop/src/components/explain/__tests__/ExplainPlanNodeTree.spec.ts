import { describe, expect, it } from "vitest";
import { readCascadeCss } from "../../../styles/__tests__/cascadeCss";

const globalStyles = readCascadeCss();

type Rgb = [number, number, number];

type ThemeColors = {
  selector: string;
  background: Rgb;
  foreground: Rgb;
  popover: Rgb;
  popoverForeground: Rgb;
};

function parseRgb(value: string): Rgb {
  const channels = value
    .match(/\d+(?:\.\d+)?/g)
    ?.slice(0, 3)
    .map(Number);
  if (!channels || channels.length !== 3) throw new Error(`Expected an opaque RGB color, received ${value}`);
  return [channels[0], channels[1], channels[2]];
}

function tokenColor(block: string, token: string): Rgb | undefined {
  const value = block.match(new RegExp(`--${token}:\\s*rgb\\(([^)]+)\\)`))?.[1];
  return value ? parseRgb(value) : undefined;
}

const themeColors: ThemeColors[] = [...globalStyles.matchAll(/(?<selector>:root|\.dark|html\.theme-[\w-]+(?:\.dark)?)\s*\{(?<block>[^{}]*)\}/g)]
  .map((match) => {
    const block = match.groups?.block ?? "";
    const background = tokenColor(block, "background");
    const foreground = tokenColor(block, "foreground");
    const popover = tokenColor(block, "popover");
    const popoverForeground = tokenColor(block, "popover-foreground");
    if (!background || !foreground || !popover || !popoverForeground) return undefined;

    return { selector: match.groups?.selector ?? "", background, foreground, popover, popoverForeground };
  })
  .filter((theme): theme is ThemeColors => !!theme);

function linearRgbChannel(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance([red, green, blue]: Rgb): number {
  return 0.2126 * linearRgbChannel(red) + 0.7152 * linearRgbChannel(green) + 0.0722 * linearRgbChannel(blue);
}

function contrastRatio(first: Rgb, second: Rgb): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

function blend(foreground: Rgb, background: Rgb, opacity: number): Rgb {
  return foreground.map((channel, index) => Math.round(channel * opacity + background[index] * (1 - opacity))) as Rgb;
}

describe("ExplainPlanNodeTree interactions", () => {
  it("keeps foreground-based tree metadata readable in every application palette", () => {
    expect(themeColors).toHaveLength(26);

    for (const theme of themeColors) {
      expect(contrastRatio(blend(theme.foreground, theme.background, 0.8), theme.background), theme.selector).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.popoverForeground, theme.popover), theme.selector).toBeGreaterThanOrEqual(4.5);
    }
  });
});
