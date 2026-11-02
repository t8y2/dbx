// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import QueryEditor from "../QueryEditor.vue";
import { useSettingsStore } from "@/stores/settingsStore";
import type { QueryEditorProps } from "../queryEditorTypes";
import { statementExecutionMarkers } from "@/lib/tabs/tabPresentation";

vi.mock("@/lib/common/clipboard", () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  readTextFromClipboard: vi.fn().mockResolvedValue(""),
}));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

async function mountEditor() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSettingsStore().editorSettings.showStatementRunButtons = true;
  const props = reactive<QueryEditorProps>({
    modelValue: "SELECT 0;\nSELECT 1;\nSELECT 2;\nSELECT 3;",
    tabId: "selection-execution",
    databaseType: "mysql",
    dialect: "mysql",
    autoFocus: false,
    statementExecutionMarkers: [],
  });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(QueryEditor, {
        ...props,
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
  return { host, props, view };
}

describe("QueryEditor statement execution status", () => {
  it.each([1, 2])(
    "renders status badges for %i selected executed statements",
    async (count) => {
      const { host, props, view } = await mountEditor();
      const first = props.modelValue.indexOf("SELECT 1");
      const last = props.modelValue.indexOf("SELECT 3");
      view.dispatch({ selection: { anchor: first, head: last } });
      props.statementExecutionMarkers = statementExecutionMarkers(
        props.modelValue,
        Array.from({ length: count }, (_, index) => ({
          columns: ["value"],
          rows: [[index + 1]],
          affected_rows: 0,
          execution_time_ms: 1,
          sourceStatement: `SELECT ${index + 1}`,
          sourceFrom: first + index * "SELECT 1;\n".length,
          sourceTo: first + index * "SELECT 1;\n".length + "SELECT 1".length,
        })),
        "mysql",
        props.modelValue.slice(first, last),
      );
      await nextTick();
      expect(host.querySelectorAll(".cm-statement-execution-badge--success")).toHaveLength(count);
    },
    30_000,
  );
});
