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
  // Explicit modifiers (instead of Mod) keep the keymap deterministic on every
  // platform, mirroring QueryEditorSelectCurrentStatement.integration.spec.ts.
  settingsStore.editorSettings.shortcuts.previousStatement = "Ctrl+Alt+ArrowUp";
  settingsStore.editorSettings.shortcuts.nextStatement = "Ctrl+Alt+ArrowDown";
  settingsStore.editorSettings.shortcuts.statementStart = "Ctrl+Alt+Home";
  const props = reactive<QueryEditorProps>({ modelValue, tabId: "statement-navigation", databaseType: "mysql", dialect: "mysql", autoFocus: false, ...overrides });
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

function pressStatementShortcut(view: EditorView, key: string, keyCode: number): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, keyCode, code: key, ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(event, "keyCode", { get: () => keyCode });
  view.contentDOM.dispatchEvent(event);
  return event;
}

function cursor(view: EditorView): number {
  return view.state.selection.main.head;
}

function placeCursor(view: EditorView, offset: number) {
  view.dispatch({ selection: { anchor: offset } });
}

describe("QueryEditor statement navigation", () => {
  const SQL = "SELECT 1;\n\nSELECT 2 FROM t;\n\nUPDATE t SET x = 1;";

  it("jumps to the next statement start from inside a statement", async () => {
    const { view } = await mountEditor(SQL);
    placeCursor(view, SQL.indexOf("SELECT 1") + 3);

    pressStatementShortcut(view, "ArrowDown", 40);
    await nextTick();

    expect(cursor(view)).toBe(SQL.indexOf("SELECT 2"));
  });

  it("walks back to the current statement start, then the previous statement", async () => {
    const { view } = await mountEditor(SQL);
    placeCursor(view, SQL.indexOf("SELECT 2") + 4);

    pressStatementShortcut(view, "ArrowUp", 38);
    await nextTick();
    expect(cursor(view)).toBe(SQL.indexOf("SELECT 2"));

    pressStatementShortcut(view, "ArrowUp", 38);
    await nextTick();
    expect(cursor(view)).toBe(SQL.indexOf("SELECT 1"));
  });

  it("jumps to the statement start from the middle of the statement", async () => {
    const { view } = await mountEditor(SQL);
    placeCursor(view, SQL.indexOf("UPDATE") + 5);

    pressStatementShortcut(view, "Home", 36);
    await nextTick();

    expect(cursor(view)).toBe(SQL.indexOf("UPDATE"));
  });

  it("keeps the caret in place on the first and last statement boundaries", async () => {
    const { view } = await mountEditor(SQL);
    const first = SQL.indexOf("SELECT 1");
    const last = SQL.indexOf("UPDATE t");
    placeCursor(view, first);

    pressStatementShortcut(view, "ArrowUp", 38);
    await nextTick();
    expect(cursor(view)).toBe(first);

    placeCursor(view, last);
    pressStatementShortcut(view, "ArrowDown", 40);
    await nextTick();
    expect(cursor(view)).toBe(last);
  });
});
