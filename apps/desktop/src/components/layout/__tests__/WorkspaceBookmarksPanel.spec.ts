// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorkspaceBookmarksPanel from "../WorkspaceBookmarksPanel.vue";
import type { QueryTab } from "@/types/database";

const mocked = vi.hoisted(() => ({ store: null as any }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => mocked.store }));
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function mountPanel() {
  const tabs = reactive([
    { id: "a", mode: "query", title: "orders.sql", sql: "-- Orders\nselect 1;\n-- 客户汇总", editorBookmarks: [1, 3] },
    { id: "b", mode: "query", title: "customers.sql", sql: "select 2;\n-- 客户详情", editorBookmarks: [2] },
    { id: "c", mode: "data", title: "data", sql: "select 3;", editorBookmarks: [1] },
  ] as QueryTab[]);
  const revealBookmark = vi.fn();
  mocked.store = { tabs, revealBookmark };
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(WorkspaceBookmarksPanel) });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  const rows = () => [...host.querySelectorAll<HTMLButtonElement>("[data-bookmark-line]")];
  const search = async (value: string) => {
    const input = host.querySelector("input")!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    return input;
  };
  return { host, tabs, revealBookmark, rows, search };
}

describe("workspace bookmarks", () => {
  it("groups all open query tabs and filters by text, file name and line", async () => {
    const { host, rows, search, revealBookmark } = mountPanel();
    expect(host.querySelectorAll("[data-bookmark-tab]")).toHaveLength(2);
    expect(rows()).toHaveLength(3);
    await search("客户");
    expect(rows()).toHaveLength(2);
    rows()[1].click();
    expect(revealBookmark).toHaveBeenLastCalledWith("b", 2);
    await search("OrDeRs.SQL");
    expect(rows()).toHaveLength(2);
    await search("3");
    expect(rows()).toHaveLength(1);
    const input = await search("customers");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
    expect(revealBookmark).toHaveBeenCalledTimes(1);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(rows()[0]);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(revealBookmark).toHaveBeenLastCalledWith("b", 2);
    await search("missing");
    expect(rows()).toHaveLength(0);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("editor.bookmarks.noMatches");
  });

  it("updates edited bookmarks and removes closed tabs without stale results", async () => {
    const { tabs, rows, host } = mountPanel();
    tabs[0].sql = "new\n-- Orders\nselect 1;\n-- 客户汇总";
    tabs[0].editorBookmarks = [2, 4];
    await nextTick();
    expect(rows()[1].dataset.bookmarkLine).toBe("4");
    tabs.splice(0, 1);
    await nextTick();
    expect(rows()).toHaveLength(1);
    expect(host.querySelector('[data-bookmark-tab="a"]')).toBeNull();
    tabs[0].editorBookmarks = [];
    await nextTick();
    expect(rows()).toHaveLength(0);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("editor.bookmarks.workspaceEmpty");
  });
});
