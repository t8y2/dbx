import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/**
 * Slices the body of one sidebar menu builder out of SidebarTreeRuntimeHost.vue.
 * Matching the builder rather than a formatted line keeps this guard indifferent
 * to how oxfmt lays the menu pushes out.
 */
function sidebarMenuBuilder(name: string): string {
  const text = source("../../sidebar/SidebarTreeRuntimeHost.vue");
  const start = text.indexOf(`function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = text.indexOf("\nfunction ", start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

describe("documentation menu placement", () => {
  it("registers the entry on database and schema nodes", () => {
    // The docs viewer documents a database or a schema, so it belongs on the
    // tree nodes that name one. buildDatabaseSidebarMenu serves both types.
    expect(sidebarMenuBuilder("buildDatabaseSidebarMenu")).toContain("docs.title");
  });

  it("keeps the entry off the sidebar's per-object menu", () => {
    expect(sidebarMenuBuilder("buildObjectSidebarMenu")).not.toContain("docs.title");
  });

  it("keeps the entry off the object browser's menus", () => {
    // openDocs never read the row's table: a table-level entry advertised a
    // scope the viewer cannot render.
    expect(source("../ObjectBrowser.vue")).not.toContain("docs.title");
  });
});
