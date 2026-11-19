// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, shallowRef } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import QueryEditor from "../QueryEditor.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { QueryEditorProps } from "../queryEditorTypes";

const apiMocks = vi.hoisted(() => ({ findStatementAtCursor: vi.fn() }));

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  findStatementAtCursor: apiMocks.findStatementAtCursor,
}));

vi.mock("@/lib/common/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/common/clipboard")>()),
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  readTextFromClipboard: vi.fn().mockResolvedValue(""),
}));

const DOCUMENT = ["CREATE TABLE t (id Int64) ENGINE = Memory;", "WITH 1 AS min_id SELECT * FROM t WHERE id >= min_id;", "SELECT 2;"].join("\n");
const WITH_STATEMENT = "WITH 1 AS min_id SELECT * FROM t WHERE id >= min_id;";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
  apiMocks.findStatementAtCursor.mockReset();
});

async function mountEditor(overrides: Partial<QueryEditorProps> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.editorSettings.sidebarMenuLayout = "full";
  useConnectionStore();
  const props = reactive<QueryEditorProps>({ modelValue: "", tabId: "context-menu-export", databaseType: "clickhouse", dialect: "clickhouse", autoFocus: false, ...overrides });
  const editor = shallowRef<InstanceType<typeof QueryEditor>>();
  const emitted: Array<{ sql: string; format: string }> = [];
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(QueryEditor, {
        ...props,
        ref: editor,
        onExportQuery: (payload: { sql: string; format: string }) => emitted.push(payload),
      }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull(), { timeout: 5000 });
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  return { view, host, emitted };
}

function menuButton(labelFragment: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].find((candidate) => candidate.textContent?.includes(labelFragment));
  expect(found, labelFragment).toBeDefined();
  return found!;
}

describe("QueryEditor context-menu query export", () => {
  it("exports only the statement at the right-click position instead of the whole document", async () => {
    apiMocks.findStatementAtCursor.mockResolvedValue(WITH_STATEMENT);
    const { view, host, emitted } = await mountEditor({ modelValue: DOCUMENT });
    // happy-dom has no layout, so the click position resolves to the caret.
    vi.spyOn(EditorView.prototype, "posAtCoords").mockReturnValue(null);
    const caret = DOCUMENT.indexOf("min_id");
    view.dispatch({ selection: { anchor: caret } });
    await nextTick();

    host.querySelector("[data-query-editor-root]")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 12 }));
    await nextTick();
    menuButton("editor.contextMenu.export").click();
    await nextTick();
    menuButton("editor.contextMenu.exportQueryResultTo").click();

    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(apiMocks.findStatementAtCursor).toHaveBeenCalledExactlyOnceWith(DOCUMENT, caret, "clickhouse");
    expect(emitted[0]).toEqual({ sql: WITH_STATEMENT, format: "csv" });
  });
});
