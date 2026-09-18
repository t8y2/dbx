import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../SidebarTreeRuntimeHost.vue", import.meta.url), "utf8");

function functionSource(name: string, nextName: string) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`async function ${nextName}`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("SidebarTreeRuntimeHost compile refresh routing", () => {
  it("refreshes the Dameng schema object list after compiling a view", () => {
    const compile = functionSource("compileDamengView", "executeXuguSchedulerJobAction");

    expect(compile).toContain("await connectionStore.refreshObjectListTreeNode(node.connectionId, node.database, node.schema);");
    expect(compile).not.toContain("await connectionStore.refreshTreeNode(node);");
  });

  it("keeps Xugu compile refresh behavior unchanged", () => {
    const compile = functionSource("compileXuguObject", "compileDamengView");

    expect(compile).toContain("await connectionStore.refreshTreeNode(node);");
    expect(compile).not.toContain("await connectionStore.refreshObjectListTreeNode");
  });
});
