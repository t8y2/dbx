import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../SchemaDiagramDialog.vue", import.meta.url), "utf8");

describe("SchemaDiagramDialog keyboard boundaries", () => {
  it("does not consume a space typed in an editable control for canvas panning", () => {
    const keydownSource = dialogSource.slice(dialogSource.indexOf("function handleKeydown"), dialogSource.indexOf("function handleKeyup"));

    expect(keydownSource).toContain('const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);');
    expect(keydownSource).toContain('if (!typing && (e.key === " " || e.key === "Spacebar"))');
  });
});
