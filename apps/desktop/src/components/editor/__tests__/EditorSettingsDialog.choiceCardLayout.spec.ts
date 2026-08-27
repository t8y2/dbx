import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cn } from "@/lib/common/utils";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");
const buttonSource = readFileSync(new URL("../../ui/button/index.ts", import.meta.url), "utf8");
const templateSource = dialogSource.slice(dialogSource.indexOf("<template>"));
const buttonBaseClass = /cva\(\s*"([^"]+)"/.exec(buttonSource)?.[1];
if (!buttonBaseClass) throw new Error("Missing shared Button base class contract");

const affectedChoiceKeys = ["tabLayoutScroll", "tabLayoutWrap", "dataTabReuseAlwaysNew", "dataTabReuseSameTable", "dataTabReuseActiveTab", "routineSourceOpenModeQueryTab", "routineSourceOpenModeDialog"] as const;

function sourceIndexForKey(key: string): number {
  const index = templateSource.indexOf(`t("settings.${key}")`);
  if (index < 0) throw new Error(`Missing settings key: ${key}`);
  return index;
}

function buttonBlockForKey(key: string): string {
  const keyIndex = sourceIndexForKey(key);
  const start = templateSource.lastIndexOf("<Button", keyIndex);
  const end = templateSource.indexOf("</Button>", keyIndex);
  if (start < 0 || end < 0) throw new Error(`Missing Button for settings key: ${key}`);
  return templateSource.slice(start, end + "</Button>".length);
}

function openingTag(source: string, element: string): string {
  const start = source.indexOf(`<${element}`);
  const end = tagEnd(source, start);
  if (start < 0 || end < 0) throw new Error(`Missing <${element}> opening tag`);
  return source.slice(start, end + 1);
}

function elementTagForKey(key: string, element = "div"): string {
  const keyIndex = sourceIndexForKey(key);
  const start = templateSource.lastIndexOf(`<${element}`, keyIndex);
  const end = tagEnd(templateSource, start);
  if (start < 0 || end < 0) throw new Error(`Missing <${element}> for settings key: ${key}`);
  return templateSource.slice(start, end + 1);
}

function elementTagForKeyInButton(buttonKey: string, key: string, element = "div"): string {
  const block = buttonBlockForKey(buttonKey);
  const keyIndex = block.indexOf(`t("settings.${key}")`);
  const start = block.lastIndexOf(`<${element}`, keyIndex);
  const end = tagEnd(block, start);
  if (keyIndex < 0 || start < 0 || end < 0) throw new Error(`Missing <${element}> for settings key ${key} in ${buttonKey}`);
  return block.slice(start, end + 1);
}

function tagEnd(source: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote && source[index - 1] !== "\\") quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return -1;
}

function classNameFromTag(tag: string): string {
  const match = /\sclass="([^"]+)"/.exec(tag);
  if (!match) throw new Error(`Missing static class attribute in: ${tag}`);
  return match[1];
}

function expectClassTokens(className: string, tokens: readonly string[]) {
  const classes = new Set(className.split(/\s+/));
  for (const token of tokens) expect(classes.has(token), `${className} should include ${token}`).toBe(true);
}

describe("EditorSettingsDialog choice card containment", () => {
  it("overrides the shared Button nowrap contract on two- and three-column cards", () => {
    for (const key of affectedChoiceKeys) {
      const cardClass = classNameFromTag(openingTag(buttonBlockForKey(key), "Button"));
      expectClassTokens(cardClass, ["settings-choice-card", "min-w-0", "whitespace-normal", "overflow-hidden"]);

      const mergedClass = cn(buttonBaseClass, cardClass);
      expectClassTokens(mergedClass, ["min-w-0", "whitespace-normal", "overflow-hidden"]);
      expect(mergedClass.split(/\s+/)).not.toContain("whitespace-nowrap");
    }
  });

  it("lets long two-column descriptions wrap inside a shrinkable text container", () => {
    for (const key of ["tabLayoutScroll", "tabLayoutWrap", "routineSourceOpenModeQueryTab", "routineSourceOpenModeDialog"] as const) {
      const block = buttonBlockForKey(key);
      expect(block).toMatch(/<div class="[^"]*\bmin-w-0\b[^"]*\btext-left\b[^"]*">/);
    }

    for (const [buttonKey, descriptionKey] of [
      ["tabLayoutScroll", "tabLayoutScrollDescription"],
      ["tabLayoutWrap", "tabLayoutWrapDescription"],
      ["routineSourceOpenModeQueryTab", "routineSourceOpenModeQueryTabDescription"],
      ["routineSourceOpenModeDialog", "routineSourceOpenModeDialogDescription"],
    ] as const) {
      expectClassTokens(classNameFromTag(elementTagForKeyInButton(buttonKey, descriptionKey)), ["whitespace-normal", "break-words"]);
    }
  });

  it("keeps three-column titles shrinkable without allowing help icons to collapse", () => {
    for (const key of ["dataTabReuseAlwaysNew", "dataTabReuseSameTable", "dataTabReuseActiveTab"] as const) {
      const block = buttonBlockForKey(key);
      expect(block).toMatch(/<div class="[^"]*\bmin-w-0\b[^"]*\btext-left\b[^"]*">/);
      expect(block).toMatch(/<div class="[^"]*\bflex\b[^"]*\bmin-w-0\b[^"]*\bitems-center\b[^"]*">/);
      expectClassTokens(classNameFromTag(elementTagForKey(key)), ["min-w-0", "break-words"]);
      expect(block).toMatch(/<span class="[^"]*\bshrink-0\b[^"]*cursor-help[^"]*"[^>]*>/);
    }
  });

  it("preserves intentional single-line truncation for cards with tooltips", () => {
    for (const key of ["appLayoutSeparatedDescription", "appLayoutClassicDescription"] as const) {
      expectClassTokens(classNameFromTag(elementTagForKey(key)), ["truncate"]);
    }
  });

  it("keeps icon theme choices compact beside the corner style controls", () => {
    expect(dialogSource).toContain("grid-template-columns: repeat(3, minmax(0, 1fr));");
    for (const key of ["iconThemeDefault", "iconThemeBlack"] as const) {
      const block = buttonBlockForKey(key);
      expectClassTokens(classNameFromTag(openingTag(block, "Button")), ["settings-choice-button", "h-8"]);
      expect(block).toContain('class="h-7 w-7 shrink-0"');
    }
  });
});
