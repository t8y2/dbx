import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");

describe("add to AI database context", () => {
  it("accepts database tree nodes with an empty database identifier", () => {
    const addToAiStart = appSource.indexOf("async function addToAi");
    const addToAiEnd = appSource.indexOf("function openAiPanel", addToAiStart);
    const addToAiSource = appSource.slice(addToAiStart, addToAiEnd);

    expect(addToAiSource).toContain("else if (hasTreeNodeDatabaseContext(node))");
    expect(addToAiSource).not.toContain("else if (node.database)");
  });

  it("adds every selected table as an AI mention", () => {
    const addToAiStart = appSource.indexOf("async function addToAi");
    const addToAiEnd = appSource.indexOf("function openAiPanel", addToAiStart);
    const addToAiSource = appSource.slice(addToAiStart, addToAiEnd);

    expect(addToAiSource).toContain("Array.isArray(nodesInput) ? nodesInput : [nodesInput]");
    expect(addToAiSource).toContain('entry.type === "table"');
    // Every selected table still becomes a mention, and it now carries the
    // binding the conversation must adopt (#9902).
    expect(addToAiSource).toContain("for (const mention of tableMentions) handle.addTableMention(mention, binding)");
  });

  it("retargets the conversation instead of moving the workspace (#9902)", () => {
    const addToAiStart = appSource.indexOf("async function addToAi");
    const addToAiEnd = appSource.indexOf("function openAiPanel", addToAiStart);
    const addToAiSource = appSource.slice(addToAiStart, addToAiEnd);

    expect(addToAiSource).toContain("const binding: AiConversationBinding = { connectionId: node.connectionId");
    // Asking about a table must not reassign the global active connection or
    // switch/create an editor tab — that is what made the AI panel's target
    // global.
    expect(addToAiSource).not.toContain("connectionStore.activeConnectionId =");
    expect(addToAiSource).not.toContain("queryStore.switchTab(");
    expect(addToAiSource).not.toContain("queryStore.createTab(");
  });
});
