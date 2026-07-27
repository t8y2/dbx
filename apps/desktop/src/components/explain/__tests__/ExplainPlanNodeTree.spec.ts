import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nodeTreeSource = readFileSync(new URL("../ExplainPlanNodeTree.vue", import.meta.url), "utf8");
const globalStyles = readFileSync(new URL("../../../styles/globals.css", import.meta.url), "utf8");

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
  it("keeps a concise preview of the most useful details in the tree row", () => {
    expect(nodeTreeSource).toContain('const detailPreviewEntries = computed(() => detailEntries.value.filter((detail) => detail.label !== "Actual Rows").slice(0, 2))');
    expect(nodeTreeSource).toContain('<div v-if="detailPreviewEntries.length"');
    expect(nodeTreeSource).toContain('v-for="(detail, index) in detailPreviewEntries"');
    expect(nodeTreeSource).toContain('class="min-w-0 flex-1 truncate"');
    expect(nodeTreeSource).not.toContain("text-muted-foreground/40");
  });

  it("shows long details in a click-triggered, selectable popover", () => {
    expect(nodeTreeSource).toContain('import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"');
    expect(nodeTreeSource).toContain('<Popover v-if="detailEntries.length">');
    expect(nodeTreeSource).toContain("<PopoverTrigger as-child>");
    expect(nodeTreeSource).toContain('<PopoverContent align="end"');
    expect(nodeTreeSource).toContain('data-native-clipboard class="max-h-');
    expect(nodeTreeSource).toContain("select-text whitespace-pre-wrap break-words");
    expect(nodeTreeSource).not.toContain("node.details.join");
    expect(nodeTreeSource).not.toContain("{{ detailEntries.length }}");
    expect(nodeTreeSource.match(/\{\{ t\("explain\.details"\) \}\}/g)).toHaveLength(1);
  });

  it("keeps detail fields distinct and tree disclosure on its own button", () => {
    expect(nodeTreeSource).toContain('const separatorIndex = detail.indexOf(":")');
    expect(nodeTreeSource).toContain('v-if="detail.label"');
    expect(nodeTreeSource).toContain('<Button v-if="hasChildren"');
    expect(nodeTreeSource).toContain(':aria-expanded="!collapsed"');
    expect(nodeTreeSource).toContain('@click="toggleCollapsed"');
    expect(nodeTreeSource).not.toContain("cursor-pointer");
    expect(nodeTreeSource).not.toContain('@click="toggle"');
  });

  it("uses semantic foreground tokens instead of fixed status hues", () => {
    expect(nodeTreeSource).toContain("text-foreground/80");
    expect(nodeTreeSource).toContain("text-popover-foreground");
    expect(nodeTreeSource).not.toMatch(/text-(?:blue|emerald|amber|green)-/);
    expect(nodeTreeSource).not.toMatch(/border-(?:blue|emerald|amber|green)-/);
  });

  it("keeps foreground-based tree metadata readable in every application palette", () => {
    expect(themeColors).toHaveLength(26);

    for (const theme of themeColors) {
      expect(contrastRatio(blend(theme.foreground, theme.background, 0.8), theme.background), theme.selector).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.popoverForeground, theme.popover), theme.selector).toBeGreaterThanOrEqual(4.5);
    }
  });
});
