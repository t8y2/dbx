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
    expect(addToAiSource).toContain("for (const mention of tableMentions) handle.addTableMention(mention)");
  });
});
