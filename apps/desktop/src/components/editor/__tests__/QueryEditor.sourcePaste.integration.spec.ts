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

// Java 风格：字符串拼接 + 源码层 `\n` 转义
const SOURCE_SQL = '"SELECT * " +\n"FROM users \\n " +\n"WHERE id = 1"';
const RESTORED_SQL = "SELECT * FROM users \n WHERE id = 1";
const PLAIN_SQL = "SELECT * FROM users WHERE id = 1";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

async function mountEditor(overrides: Partial<QueryEditorProps> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  useConnectionStore();
  const props = reactive<QueryEditorProps>({ modelValue: "", tabId: "source-paste", databaseType: "mysql", dialect: "mysql", autoFocus: false, ...overrides });
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

/** 构造带纯文本剪贴板内容的 paste 事件（happy-dom 没有 ClipboardEvent 实现） */
function pasteEvent(text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? text : "") } });
  return event;
}

async function pasteInto(view: EditorView, text: string): Promise<Event> {
  const event = pasteEvent(text);
  view.contentDOM.dispatchEvent(event);
  await nextTick();
  return event;
}

describe("QueryEditor source-code SQL paste", () => {
  it("restores concatenated source SQL when the setting is enabled", async () => {
    const { view, settingsStore } = await mountEditor();
    expect(settingsStore.editorSettings.restoreSqlFromSourcePasteEnabled).toBe(true);

    await pasteInto(view, SOURCE_SQL);
    expect(view.state.doc.toString()).toBe(RESTORED_SQL);
  });

  it("claims the paste event when it restores the SQL", async () => {
    const { view } = await mountEditor();

    // 还原路径自己完成插入并阻止默认粘贴，保证只写入一次
    const event = await pasteInto(view, SOURCE_SQL);
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(RESTORED_SQL);
  });

  it("keeps the pasted text untouched when the setting is disabled", async () => {
    const { view, settingsStore } = await mountEditor();
    settingsStore.editorSettings.restoreSqlFromSourcePasteEnabled = false;

    await pasteInto(view, SOURCE_SQL);
    expect(view.state.doc.toString()).not.toBe(RESTORED_SQL);
  });

  it("keeps the pasted text untouched when the editor is read-only", async () => {
    const { view } = await mountEditor({ readOnly: true });

    await pasteInto(view, SOURCE_SQL);
    expect(view.state.doc.toString()).toBe("");
  });

  it("replaces the current selection with the restored SQL as one undoable edit", async () => {
    const { view } = await mountEditor({ modelValue: "SELECT 0" });
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });

    await pasteInto(view, SOURCE_SQL);
    expect(view.state.doc.toString()).toBe(RESTORED_SQL);
  });

  it("leaves plain SQL paste to the default editor behavior", async () => {
    const { view } = await mountEditor();

    await pasteInto(view, PLAIN_SQL);
    expect(view.state.doc.toString()).not.toBe(RESTORED_SQL);
  });
});
