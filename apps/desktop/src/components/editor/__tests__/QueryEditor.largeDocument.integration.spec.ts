// @vitest-environment happy-dom

import { createApp, h, nextTick, ref, shallowRef, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { language } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH } from "@/lib/editor/queryEditorLargeDocument";
import type { QueryEditorProps } from "../queryEditorTypes";

const analysisProbe = vi.hoisted(() => ({
  documentLengths: [] as number[],
  failAtLength: Number.POSITIVE_INFINITY,
}));

vi.mock("@/lib/sql/executableStatementRangeCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sql/executableStatementRangeCache")>();
  return {
    ...actual,
    executableStatementRangeCacheForDoc: (...args: Parameters<typeof actual.executableStatementRangeCacheForDoc>) => {
      analysisProbe.documentLengths.push(args[1].length);
      if (args[1].length >= analysisProbe.failAtLength) throw new Error("unbounded statement analysis");
      return actual.executableStatementRangeCacheForDoc(...args);
    },
  };
});

import QueryEditor from "../QueryEditor.vue";

function oraclePackage(procedureCount: number): string {
  const procedures = Array.from(
    { length: procedureCount },
    (_, index) => `  PROCEDURE process_order_${index}(p_order_id NUMBER) IS
    l_status VARCHAR2(30);
  BEGIN
    SELECT status INTO l_status FROM orders WHERE id = p_order_id;
    IF l_status = 'PENDING' THEN
      UPDATE orders SET status = 'PROCESSED' WHERE id = p_order_id;
    END IF;
  EXCEPTION
    WHEN NO_DATA_FOUND THEN NULL;
  END process_order_${index};
`,
  ).join("");
  return `CREATE OR REPLACE PACKAGE BODY huge_pkg AS\n${procedures}END huge_pkg;\n/\n`;
}

const cleanups: Array<() => void> = [];

beforeEach(() => {
  analysisProbe.documentLengths = [];
  analysisProbe.failAtLength = Number.POSITIVE_INFINITY;
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function mountEditor(modelValue: string, overrides: Partial<QueryEditorProps> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const host = document.createElement("div");
  document.body.append(host);
  const editor = shallowRef<InstanceType<typeof QueryEditor>>();
  const source = ref(modelValue);
  const onUpdateModelValue = vi.fn((value: string) => {
    source.value = value;
  });
  const app: App = createApp({
    render: () =>
      h(QueryEditor, {
        modelValue: source.value,
        tabId: "oracle-source",
        databaseType: "oracle",
        dialect: "postgres",
        autoFocus: false,
        ref: editor,
        "onUpdate:modelValue": onUpdateModelValue,
        ...overrides,
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
  return { editor: editor.value!, host, onUpdateModelValue, view };
}

describe("QueryEditor large document mode", () => {
  it("keeps the full editor feature path for ordinary documents", async () => {
    const source = oraclePackage(8);
    const { host, view } = await mountEditor(source);

    expect(host.firstElementChild?.hasAttribute("data-large-document-mode")).toBe(false);
    expect(analysisProbe.documentLengths).toContain(source.length);
    expect(view.state.facet(language)).not.toBeNull();
    expect(view.state.doc.toString()).toBe(source);
  });

  it("keeps a realistically large package editable and searchable without full-document analysis", async () => {
    const source = oraclePackage(4_000);
    expect(source.length).toBeGreaterThan(QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH);
    analysisProbe.failAtLength = QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH + 1;

    const { editor, host, onUpdateModelValue, view } = await mountEditor(source);

    expect(host.firstElementChild?.getAttribute("data-large-document-mode")).toBe("true");
    expect(analysisProbe.documentLengths).not.toContain(source.length);
    expect(view.state.facet(language)).toBeNull();
    expect(view.state.doc.toString()).toBe(source);
    expect(view.state.readOnly).toBe(false);
    expect(view.state.sliceDoc(0, 24)).toBe(source.slice(0, 24));
    expect(editor.openSearch()).toBe(true);
    await nextTick();
    expect(host.querySelector(".editor-search-panel input")).not.toBeNull();

    view.dispatch({ changes: { from: source.length, insert: "-- edited\n" }, userEvent: "input" });
    await nextTick();
    expect(onUpdateModelValue).toHaveBeenLastCalledWith(`${source}-- edited\n`);
  });

  it("preserves read-only state when full-document analysis would fail", async () => {
    const source = oraclePackage(4_000);
    analysisProbe.failAtLength = QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH + 1;

    const { host, view } = await mountEditor(source, { readOnly: true });

    expect(host.firstElementChild?.getAttribute("data-large-document-mode")).toBe("true");
    expect(analysisProbe.documentLengths).not.toContain(source.length);
    expect(view.state.doc.toString()).toBe(source);
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
  });
});
