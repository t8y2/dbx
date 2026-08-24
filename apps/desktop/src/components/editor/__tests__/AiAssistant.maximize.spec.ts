import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");

describe("AI assistant maximize control", () => {
  it("exposes a parent-controlled maximize toggle with accessible labels", () => {
    expect(source).toContain("maximized?: boolean;");
    expect(source).toContain("toggleMaximize: [];");
    expect(source).toContain(":title=\"props.maximized ? t('ai.restore') : t('ai.maximize')\"");
    expect(source).toContain(":aria-label=\"props.maximized ? t('ai.restore') : t('ai.maximize')\"");
    expect(source).toContain(':aria-pressed="props.maximized"');
    expect(source).toContain("@click=\"emit('toggleMaximize')\"");
    expect(source).toContain('<Minimize2 v-if="props.maximized"');
    expect(source).toContain("<Maximize2 v-else");
  });
});
