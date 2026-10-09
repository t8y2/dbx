// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { SavedSqlFile } from "@/types/database";
import SqlLibrarySearchSnippet from "../SqlLibrarySearchSnippet.vue";

const mounted: Array<{ app: App; host: HTMLElement }> = [];

function sampleFile(sql: string): SavedSqlFile {
  return {
    id: "test-file-1",
    connectionId: "conn-1",
    name: "users_query.sql",
    database: "main",
    sql,
    sqlLoaded: true,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  };
}

function mountSnippet(file: SavedSqlFile, query: string, onSelectMatch?: (match: any) => void) {
  setActivePinia(createPinia());
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(SqlLibrarySearchSnippet, {
    file,
    query,
    onSelectMatch,
  });
  app.use(i18n);
  app.mount(host);
  mounted.push({ app, host });
  return host;
}

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("SqlLibrarySearchSnippet", () => {
  it("renders nothing when there are no matches", async () => {
    const host = mountSnippet(sampleFile("SELECT 1;"), "orders");
    await nextTick();

    const snippetContainer = host.querySelector(".dbx-sql-library-snippets");
    expect(snippetContainer).toBeNull();
  });

  it("renders matching line with line number and highlight mark", async () => {
    const sql = ["-- comments", "SELECT id, username FROM users", "WHERE active = true;"].join("\n");

    const host = mountSnippet(sampleFile(sql), "users");
    await nextTick();

    const container = host.querySelector(".dbx-sql-library-snippets");
    expect(container).not.toBeNull();

    const snippetRows = host.querySelectorAll(".group\\/snippet");
    expect(snippetRows).toHaveLength(1);

    const lineBadge = snippetRows[0].querySelector("span");
    expect(lineBadge?.textContent?.trim()).toBe("L2");

    const mark = snippetRows[0].querySelector("mark");
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe("users");

    // Tooltip should contain multi-line context
    const titleAttr = snippetRows[0].getAttribute("title");
    expect(titleAttr).toContain("1 | -- comments");
    expect(titleAttr).toContain("2 | SELECT id, username FROM users");
    expect(titleAttr).toContain("3 | WHERE active = true;");
  });

  it("emits selectMatch with line and column on click", async () => {
    const sql = "SELECT * FROM orders WHERE status = 'pending';";
    const onSelectMatch = vi.fn();
    const host = mountSnippet(sampleFile(sql), "orders", onSelectMatch);
    await nextTick();

    const snippetRow = host.querySelector<HTMLElement>(".group\\/snippet");
    expect(snippetRow).not.toBeNull();
    snippetRow!.click();
    await nextTick();

    expect(onSelectMatch).toHaveBeenCalledTimes(1);
    expect(onSelectMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        lineNumber: 1,
        column: 15,
        lineText: "SELECT * FROM orders WHERE status = 'pending';",
      }),
    );
  });

  it("limits to 3 matches initially and expands on button click", async () => {
    const sql = ["SELECT 1 FROM tbl;", "SELECT 2 FROM tbl;", "SELECT 3 FROM tbl;", "SELECT 4 FROM tbl;", "SELECT 5 FROM tbl;"].join("\n");

    const host = mountSnippet(sampleFile(sql), "SELECT");
    await nextTick();

    let snippetRows = host.querySelectorAll(".group\\/snippet");
    expect(snippetRows).toHaveLength(3);

    const toggleButton = host.querySelector<HTMLButtonElement>("button");
    expect(toggleButton).not.toBeNull();
    expect(toggleButton?.textContent).toContain("2");

    // Click to expand
    toggleButton!.click();
    await nextTick();

    snippetRows = host.querySelectorAll(".group\\/snippet");
    expect(snippetRows).toHaveLength(5);
    expect(toggleButton?.textContent?.trim()).toBe(i18n.global.t("sqlLibrary.collapseMatches"));

    // Click to collapse
    toggleButton!.click();
    await nextTick();

    snippetRows = host.querySelectorAll(".group\\/snippet");
    expect(snippetRows).toHaveLength(3);
  });
});
