import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../ObjectBrowser.vue", import.meta.url), "utf8");

function functionBody(name: string): string {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*(?::\\s*[^\\{]+)?\\{`, "m").exec(source);
  if (!signature) throw new Error(`Missing function ${name}`);
  const bodyStart = signature.index + signature[0].length;
  let depth = 1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart, index);
  }
  throw new Error(`Unclosed function ${name}`);
}

describe("ObjectBrowser add to AI", () => {
  it("declares the addToAi emit for table context hand-off", () => {
    const emitDeclaration = source.slice(source.indexOf("const emit = defineEmits"), source.indexOf(">();", source.indexOf("const emit = defineEmits")));
    expect(emitDeclaration).toContain("addToAi");
  });

  it("adds an 'Add to AI' menu item after 'New Query' in the table menu", () => {
    const tableMenu = functionBody("getTableMenuItems");
    const newQueryIndex = tableMenu.indexOf('t("contextMenu.newQuery")');
    const addToAiIndex = tableMenu.indexOf("addToAiMenuItem(item)");
    expect(newQueryIndex).toBeGreaterThan(-1);
    expect(addToAiIndex).toBeGreaterThan(newQueryIndex);
  });

  it("guards the menu item behind supportsAiAssistantContext", () => {
    const tableMenu = functionBody("getTableMenuItems");
    expect(tableMenu).toContain("supportsAiAssistantContext(effectiveDatabaseType.value)");
    expect(tableMenu).toContain("[addToAiMenuItem(item)]");
  });

  it("offers 'Add to AI' in the VictoriaMetrics early-return branch too", () => {
    const tableMenu = functionBody("getTableMenuItems");
    // The VM branch is the first block inside getTableMenuItems; verify it guards
    // the same AI entry so ObjectBrowser stays consistent with the sidebar tree.
    const vmBranchStart = tableMenu.indexOf("if (isVictoriaMetrics.value)");
    const vmBranchEnd = tableMenu.indexOf("const useBatchActions", vmBranchStart);
    const vmBranch = tableMenu.slice(vmBranchStart, vmBranchEnd);

    expect(vmBranch).toContain("supportsAiAssistantContext(effectiveDatabaseType.value)");
    expect(vmBranch).toContain("[addToAiMenuItem(item)]");
    expect(vmBranch.indexOf("addToAiMenuItem(item)")).toBeGreaterThan(vmBranch.indexOf('t("contextMenu.newQuery")'));
  });

  it("emits selected tables (batch) or the single table with per-row schema", () => {
    const addToAi = functionBody("addToAiMenuItem");
    expect(addToAi).toContain("selectedTableRows.value.map((row) => ({ name: row.name, schema: row.schema }))");
    expect(addToAi).toContain('emit("addToAi", targets)');
    expect(addToAi).toContain('t("contextMenu.addToAiMultiple", { count })');
    expect(addToAi).toContain('t("contextMenu.addToAi")');
  });
});
