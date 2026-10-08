// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, shallowRef } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import QueryEditor from "../QueryEditor.vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type { QueryEditorProps } from "../queryEditorTypes";

vi.mock("@/lib/common/clipboard", () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  readTextFromClipboard: vi.fn().mockResolvedValue(""),
}));

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

async function mountEditor(modelValue: string, overrides: Partial<QueryEditorProps> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  useConnectionStore();
  settingsStore.editorSettings.showExecutionTargetPicker = false;
  settingsStore.editorSettings.executeMode = "current";
  settingsStore.editorSettings.executeAllOnBlankLine = false;
  // 快捷键用显式修饰键（而不是 Mod）书写，让用例在所有平台上确定性地触发，
  // 与 QueryEditorSearchKeymap.spec.ts 的做法一致。
  settingsStore.editorSettings.shortcuts.selectCurrentStatement = "Ctrl+Shift+E";
  const props = reactive<QueryEditorProps>({ modelValue, tabId: "select-current-statement", databaseType: "mysql", dialect: "mysql", autoFocus: false, ...overrides });
  const editor = shallowRef<InstanceType<typeof QueryEditor>>();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(QueryEditor, {
        ...props,
        ref: editor,
        "onUpdate:modelValue": (value: string) => {
          props.modelValue = value;
        },
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
  return { view, props, settingsStore };
}

/** 派发选中当前语句的快捷键（Ctrl+Shift+E 在所有平台归一化结果一致） */
function pressSelectCurrentStatement(view: EditorView): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "E", keyCode: 69, code: "KeyE", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(event, "keyCode", { get: () => 69 });
  view.contentDOM.dispatchEvent(event);
  return event;
}

function selectedText(view: EditorView): string {
  const { from, to } = view.state.selection.main;
  return view.state.sliceDoc(from, to);
}

function placeCursor(view: EditorView, offset: number) {
  view.dispatch({ selection: { anchor: offset } });
}

describe("QueryEditor select current statement", () => {
  it("selects the statement under the cursor without the trailing semicolon", async () => {
    const sql = "SELECT 1;\nSELECT 2 FROM t;\nSELECT 3;";
    const { view } = await mountEditor(sql);
    placeCursor(view, sql.indexOf("SELECT 2") + 5);

    pressSelectCurrentStatement(view);
    await nextTick();

    expect(selectedText(view)).toBe("SELECT 2 FROM t");
  });

  it("ignores semicolons inside string literals", async () => {
    const sql = "SELECT ';' FROM t;\nSELECT 2;";
    const { view } = await mountEditor(sql);
    placeCursor(view, sql.indexOf("SELECT 2") + 3);

    pressSelectCurrentStatement(view);
    await nextTick();

    expect(selectedText(view)).toBe("SELECT 2");
  });

  it("keeps selection-only behavior available in read-only editors", async () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const { view } = await mountEditor(sql, { readOnly: true });
    placeCursor(view, sql.indexOf("SELECT 2") + 2);

    pressSelectCurrentStatement(view);
    await nextTick();

    expect(selectedText(view)).toBe("SELECT 2");
  });

  it("leaves the selection untouched when there is no executable statement", async () => {
    const { view } = await mountEditor("-- only a comment");
    placeCursor(view, 3);

    pressSelectCurrentStatement(view);
    await nextTick();

    expect(selectedText(view)).toBe("");
    expect(view.state.selection.main.empty).toBe(true);
  });
});
