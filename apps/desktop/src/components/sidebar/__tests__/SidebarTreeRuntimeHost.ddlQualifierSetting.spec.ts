import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runtimeSource = readFileSync(fileURLToPath(new URL("../SidebarTreeRuntimeHost.vue", import.meta.url)), "utf8");

function asyncFunctionSource(name: string): string {
  const start = runtimeSource.indexOf(`async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = runtimeSource.indexOf("\nasync function ", start + 1);
  return runtimeSource.slice(start, next === -1 ? undefined : next);
}

describe("SidebarTreeRuntimeHost DDL database qualifier setting (#9421)", () => {
  it("applies the setting with each target catalog before identifier quote formatting", () => {
    const openDdl = asyncFunctionSource("openSidebarMultiTableDdlTab");
    const formatterCall = openDdl.indexOf("formatSidebarDdlTemplateForDisplay(");

    expect(formatterCall).toBeGreaterThan(-1);
    expect(openDdl.slice(formatterCall, openDdl.indexOf(");", formatterCall))).toContain("target.catalog");
  });
});
