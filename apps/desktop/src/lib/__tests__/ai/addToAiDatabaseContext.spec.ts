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

  it("retargets even when the entry adds no table mention", () => {
    // "Ask AI" on a connection or database node produces no mentions at all, so
    // applying the binding only inside the mention loop would silently skip it.
    const addToAiStart = appSource.indexOf("async function addToAi");
    const addToAiEnd = appSource.indexOf("function openAiPanel", addToAiStart);
    const addToAiSource = appSource.slice(addToAiStart, addToAiEnd);

    expect(addToAiSource).toContain("void handle.bindConversation(binding);");
    // The call must not live inside the mention loop.
    const loopIdx = addToAiSource.indexOf("for (const mention of tableMentions)");
    const bindIdx = addToAiSource.indexOf("void handle.bindConversation(binding);");
    expect(bindIdx).toBeLessThan(loopIdx);
  });

  it("resolves the AI execution tab by the exact namespace", () => {
    // `(!schema || tab.schema === schema)` used to accept a tab on ANY schema
    // when the target had none, and execution then inherited that tab's schema.
    const start = appSource.indexOf("function ensureQueryTabForConnection");
    const body = appSource.slice(start, appSource.indexOf("queryStore.createTab", start));

    expect(body).toContain("(tab.schema || undefined) === schema");
    expect(body).not.toContain("!schema ||");
  });
});
