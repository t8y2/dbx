// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, type App } from "vue";
import { createPinia, disposePinia, type Pinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorView } from "@codemirror/view";
import { undo, undoDepth } from "@codemirror/commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectSourceDialog from "../ObjectSourceDialog.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

const backend = vi.hoisted(() => ({
  getObjectSource: vi.fn(),
  buildEditableObjectSource: vi.fn(async (input: { source: string }) => input.source),
  executeQuery: vi.fn(),
  cancelQuery: vi.fn(async () => true),
  checkConnectionHealth: vi.fn(async () => undefined),
  listCompletionObjects: vi.fn(async () => []),
  listPlugins: vi.fn(async () => []),
}));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), ...backend }));
const mounted: Array<{ app: App; host: HTMLElement; pinia: Pinia }> = [];
const source = "CREATE OR REPLACE PROCEDURE P AS BEGIN NULL; END;";
function button(text: string) {
  return [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === text)!;
}
function mountDialog(initialSection: "source" | "dependencies" = "source") {
  const pinia = createPinia();
  const connections = useConnectionStore(pinia);
  connections.connectedIds.add("original");
  connections.connections = [{ id: "original", name: "original", db_type: "oracle", host: "localhost", port: 1521, username: "test", password: "" }];
  const open = ref(true),
    onOpenObject = vi.fn();
  const app = createApp({
    render: () =>
      h(ObjectSourceDialog, {
        open: open.value,
        connectionId: "original",
        database: "ORCL",
        schema: "APP",
        name: "P",
        objectType: "PROCEDURE",
        databaseType: "oracle",
        dialect: "mysql",
        initialSection,
        onOpenObject,
        "onUpdate:open": (value: boolean) => {
          open.value = value;
        },
      }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  const host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  mounted.push({ app, host, pinia });
  return { open, onOpenObject };
}
beforeEach(() => {
  vi.clearAllMocks();
  backend.getObjectSource.mockResolvedValue({ name: "P", object_type: "PROCEDURE", source });
  backend.executeQuery.mockResolvedValue({
    columns: ["DIRECTION", "OBJECT_OWNER", "OBJECT_NAME", "OBJECT_TYPE", "REFERENCED_OWNER", "REFERENCED_NAME", "REFERENCED_TYPE", "DEPENDENCY_TYPE", "REFERENCED_LINK_NAME"],
    rows: [["DEPENDS_ON", "APP", "P", "PROCEDURE", "Other.Owner", "Mixed.Table", "TABLE", "HARD", null]],
    affected_rows: 0,
    execution_time_ms: 1,
  });
});
afterEach(() => {
  for (const item of mounted.splice(0)) {
    item.app.unmount();
    item.host.remove();
    disposePinia(item.pinia);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("source dialog dependency integration", () => {
  it("keeps the real CodeMirror draft, undo history and selection through dependency refresh", async () => {
    const { open, onOpenObject } = mountDialog();
    await vi.waitFor(() => expect(button("contextMenu.editObject")?.disabled).toBe(false));
    button("contextMenu.editObject").click();
    await vi.waitFor(() => expect(document.querySelector("[data-object-source-editor] .cm-editor")).not.toBeNull());
    const editor = document.querySelector<HTMLElement>("[data-object-source-editor] .cm-editor")!;
    const view = EditorView.findFromDOM(editor)!;
    const original = view.state.doc.toString();
    view.dispatch({ changes: { from: original.length, insert: "\n-- my draft" }, selection: { anchor: 2, head: 8 } });
    await nextTick();
    const draft = view.state.doc.toString();
    button("objectDependencies.dependencies").click();
    await vi.waitFor(() => expect(button("Mixed.Table")).toBeTruthy());
    button("common.refresh").click();
    await vi.waitFor(() => expect(backend.executeQuery).toHaveBeenCalledTimes(2));
    button("objectDependencies.viewSql").click();
    await nextTick();
    const queries = useQueryStore();
    expect(queries.tabs.at(-1)?.sql).toContain("ALL_DEPENDENCIES");
    expect(queries.tabs.at(-1)?.lastExecutedSql).toBeUndefined();
    expect(backend.executeQuery).toHaveBeenCalledTimes(2);
    queries.createTab("other-connection", "other-database", "Other query");
    button("objects.source").click();
    await nextTick();
    expect(document.querySelector("[data-object-source-editor] .cm-editor")).toBe(editor);
    expect(view.state.doc.toString()).toBe(draft);
    expect([view.state.selection.main.anchor, view.state.selection.main.head]).toEqual([2, 8]);
    expect(undoDepth(view.state)).toBeGreaterThan(0);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(original);
    view.dispatch({ changes: { from: original.length, insert: "\n-- keep me" } });
    await nextTick();
    button("objectDependencies.dependencies").click();
    await nextTick();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    button("Mixed.Table").click();
    expect(confirm).toHaveBeenCalled();
    expect(open.value).toBe(true);
    expect(onOpenObject).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    button("Mixed.Table").click();
    expect(open.value).toBe(false);
    expect(onOpenObject).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "original", database: "ORCL", schema: "APP" }), expect.objectContaining({ name: "Mixed.Table", schema: "Other.Owner", type: "table" }));
    expect(backend.executeQuery.mock.calls.every((call) => String(call[2]).includes("ALL_DEPENDENCIES"))).toBe(true);
  });

  it("loads dependencies even when source loading fails", async () => {
    backend.getObjectSource.mockRejectedValue(new Error("source denied"));
    mountDialog("dependencies");
    await vi.waitFor(() => expect(button("Mixed.Table")).toBeTruthy());
    const selected = document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
    expect(selected.textContent).toBe("objectDependencies.dependencies");
    expect(backend.executeQuery).toHaveBeenCalledTimes(1);
    button("objects.source").click();
    await nextTick();
    expect(document.body.textContent).toContain("source denied");
  });
});
