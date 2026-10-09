// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";

import QueryEditor from "@/components/editor/QueryEditor.vue";
import { compressSqlText, formatSqlForEditing } from "@/lib/sql/sqlFormatter";
import { DEFAULT_SQL_FORMATTER_SETTINGS } from "@/lib/sql/sqlFormatterConfig";
import type { DatabaseType } from "@/types/database";

// The request ids are per-kind global counters in App.vue, so ids keep
// increasing for the lifetime of the process. The module-scope replay cursor in
// QueryEditor.vue survives across the editor mounts in this file, so every test
// must advance its ids monotonically (never reuse a smaller id) to mirror the
// production counter.
//
// The sample is long enough that formatting cannot collapse it onto one line:
// the default style joins a statement that fits onto one line, and the replay
// assertions below need a multi-line result.
const ORIGINAL_SQL = "select id, name, email, status, created_at, updated_at, tenant_id\nfrom users\nwhere status = 'active'\nand tenant_id = 42\nand deleted_at is null";
const COMPRESSED_SQL = compressSqlText(ORIGINAL_SQL, "mysql");
const FORMATTED_SQL = await formatSqlForEditing(COMPRESSED_SQL, "mysql", DEFAULT_SQL_FORMATTER_SETTINGS);

const cleanups: Array<() => void> = [];

type EditorState = {
  tabId: string;
  modelValue: string;
  formatRequestId: number | undefined;
  compressRequestId: number | undefined;
};

const WAIT = { timeout: 5000, interval: 20 };

function mountEditor(initial: { modelValue: string; tabId: string; databaseType?: DatabaseType; formatRequestId?: number; compressRequestId?: number }) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const state = reactive<EditorState>({
    tabId: initial.tabId,
    modelValue: initial.modelValue,
    formatRequestId: initial.formatRequestId,
    compressRequestId: initial.compressRequestId,
  });
  const emits: string[] = [];
  const root = defineComponent({
    setup: () => () =>
      h(QueryEditor, {
        modelValue: state.modelValue,
        tabId: state.tabId,
        databaseType: initial.databaseType ?? "mysql",
        dialect: "mysql",
        formatDialect: "mysql",
        autoFocus: false,
        formatRequestId: state.formatRequestId,
        compressRequestId: state.compressRequestId,
        "onUpdate:modelValue": (value: string) => {
          emits.push(value);
          // Mirror the app: App.vue writes the emitted text back into the tab
          // store, so the modelValue prop follows the editor document.
          state.modelValue = value;
        },
      }),
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(root);
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  return { state, emits, host, unmount: () => app.unmount() };
}

async function waitForEditor(host: HTMLElement) {
  await vi.waitFor(() => {
    expect(host.querySelector(".cm-editor")).not.toBeNull();
  }, WAIT);
}

// Flush the watcher queue, the microtask queue and the timers the editor uses
// for its async format path in one go.
async function settle() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("QueryEditor format/compress request replay", () => {
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("does not replay the stale compress/format requests when the ids re-arm after a tab switch", async () => {
    // Preconditions: the sample must be recompressible and format must produce
    // a distinct multi-line document, otherwise the replay would be a no-op.
    expect(COMPRESSED_SQL).not.toBe(ORIGINAL_SQL);
    expect(FORMATTED_SQL).not.toBe(COMPRESSED_SQL);
    expect(FORMATTED_SQL).toContain("\n");

    const { state, emits, host } = mountEditor({ modelValue: ORIGINAL_SQL, tabId: "tab-a" });
    await waitForEditor(host);

    // Toolbar compress, then toolbar format, on the active tab.
    state.compressRequestId = 1;
    await vi.waitFor(() => expect(emits.at(-1)).toBe(COMPRESSED_SQL), WAIT);

    state.formatRequestId = 1;
    await vi.waitFor(() => expect(emits.at(-1)).toBe(FORMATTED_SQL), WAIT);

    // Switch to another SQL file: ContentArea gates the inactive tab's request
    // props back to undefined on the same reused editor instance.
    state.tabId = "tab-b";
    state.formatRequestId = undefined;
    state.compressRequestId = undefined;
    await settle();

    // Switch back: the same stale ids re-arm, which is the replay trigger.
    state.tabId = "tab-a";
    state.formatRequestId = 1;
    state.compressRequestId = 1;
    await settle();
    await settle();

    // The replayed compress must not undo the user's later format.
    expect(emits.at(-1)).toBe(FORMATTED_SQL);
  });

  it("still applies a genuinely new request id", async () => {
    const { state, emits, host } = mountEditor({ modelValue: ORIGINAL_SQL, tabId: "tab-a" });
    await waitForEditor(host);

    state.compressRequestId = 2;
    await vi.waitFor(() => expect(emits.at(-1)).toBe(COMPRESSED_SQL), WAIT);

    state.formatRequestId = 2;
    await vi.waitFor(() => expect(emits.at(-1)).toBe(FORMATTED_SQL), WAIT);
  });

  it("does not replay a stale id on a fresh mount", async () => {
    const first = mountEditor({ modelValue: ORIGINAL_SQL, tabId: "tab-a" });
    await waitForEditor(first.host);

    first.state.formatRequestId = 3;
    await vi.waitFor(() => expect(first.emits.at(-1)).toBe(FORMATTED_SQL), WAIT);
    first.unmount();

    // Data-page remount path: a new editor instance mounts while the global
    // request still holds the stale id for this tab.
    const second = mountEditor({ modelValue: COMPRESSED_SQL, tabId: "tab-a", formatRequestId: 3, compressRequestId: 3 });
    await waitForEditor(second.host);
    await settle();
    await settle();

    expect(second.emits).toEqual([]);
  });

  it("keeps the whole-document format caret on its original SQL token", async () => {
    const { state, emits, host } = mountEditor({ modelValue: COMPRESSED_SQL, tabId: "tab-a" });
    await waitForEditor(host);
    const editorView = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    const caret = COMPRESSED_SQL.lastIndexOf("tenant_id") + 4;
    editorView.dispatch({ selection: { anchor: caret } });

    state.formatRequestId = 4;
    await vi.waitFor(() => expect(emits.at(-1)).toBe(FORMATTED_SQL), WAIT);

    expect(editorView.state.selection.main.head).toBe(FORMATTED_SQL.lastIndexOf("tenant_id") + 4);
    expect(editorView.state.selection.main.head).toBeLessThan(editorView.state.doc.length);
    expect(undo(editorView)).toBe(true);
    expect(editorView.state.doc.toString()).toBe(COMPRESSED_SQL);
    expect(editorView.state.selection.main.head).toBe(caret);
    expect(undo(editorView)).toBe(false);
  });

  it("does not move the caret or dispatch a change when a parse failure returns the source", async () => {
    const source = "SELECT 1 .";
    const { state, emits, host } = mountEditor({ modelValue: source, tabId: "tab-a" });
    await waitForEditor(host);
    const editorView = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    const caret = source.indexOf("1");
    editorView.dispatch({ selection: { anchor: caret } });

    state.formatRequestId = 5;
    await settle();
    await settle();

    expect(emits).toEqual([]);
    expect(editorView.state.selection.main.head).toBe(caret);
  });

  it.each([
    ["forward", 0, COMPRESSED_SQL.length, 0, FORMATTED_SQL.length, 6],
    ["reverse", COMPRESSED_SQL.length, 0, FORMATTED_SQL.length, 0, 7],
  ] as const)("keeps a %s formatted SQL selection complete and in its original direction", async (_direction, anchor, head, expectedAnchor, expectedHead, requestId) => {
    const { state, emits, host } = mountEditor({ modelValue: COMPRESSED_SQL, tabId: "tab-a" });
    await waitForEditor(host);
    const editorView = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    editorView.dispatch({ selection: { anchor, head } });

    state.formatRequestId = requestId;
    await vi.waitFor(() => expect(emits.at(-1)).toBe(FORMATTED_SQL), WAIT);

    expect(editorView.state.selection.main.anchor).toBe(expectedAnchor);
    expect(editorView.state.selection.main.head).toBe(expectedHead);
  });

  it.each([
    {
      name: "Mongo shell",
      databaseType: "mongodb",
      source: 'db.items.find({name:"Ada",age:42});',
      formatted: 'db.items.find({\n  name: "Ada",\n  age: 42\n});',
      requestId: 8,
    },
    {
      name: "Elasticsearch request",
      databaseType: "elasticsearch",
      source: 'GET /items/_search {"query":{"match_all":{}}}',
      formatted: 'GET /items/_search\n{\n  "query": {\n    "match_all": {}\n  }\n}',
      requestId: 9,
    },
    {
      name: "JSON",
      databaseType: "mysql",
      source: '{"name":"Ada","items":[1,2]}',
      formatted: '{\n  "name": "Ada",\n  "items": [\n    1,\n    2\n  ]\n}',
      requestId: 10,
    },
    {
      name: "XML",
      databaseType: "mysql",
      source: '<root><item id="1"/><item id="2"/></root>',
      formatted: '<root>\n  <item id="1"/>\n  <item id="2"/>\n</root>',
      requestId: 11,
    },
  ] as const)("keeps the existing whole-document caret behavior for $name formatting", async ({ databaseType, source, formatted, requestId }) => {
    const { state, emits, host } = mountEditor({ modelValue: source, tabId: "tab-a", databaseType });
    await waitForEditor(host);
    const editorView = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    editorView.dispatch({ selection: { anchor: Math.floor(source.length / 2) } });

    state.formatRequestId = requestId;
    await vi.waitFor(() => expect(emits.at(-1)).toBe(formatted), WAIT);

    expect(editorView.state.selection.main.anchor).toBe(formatted.length);
    expect(editorView.state.selection.main.head).toBe(formatted.length);
  });

  it("keeps the existing forward full-range selection for non-SQL formatting", async () => {
    const source = '{"name":"Ada","items":[1,2]}';
    const formatted = '{\n  "name": "Ada",\n  "items": [\n    1,\n    2\n  ]\n}';
    const { state, emits, host } = mountEditor({ modelValue: source, tabId: "tab-a" });
    await waitForEditor(host);
    const editorView = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    editorView.dispatch({ selection: { anchor: source.length, head: 0 } });

    state.formatRequestId = 12;
    await vi.waitFor(() => expect(emits.at(-1)).toBe(formatted), WAIT);

    expect(editorView.state.selection.main.anchor).toBe(0);
    expect(editorView.state.selection.main.head).toBe(formatted.length);
  });

  it.each([
    ["whole document", false, 13],
    ["full selection", true, 14],
  ] as const)("formats MySQL view CASE/REPLACE calls through the %s toolbar request", async (_name, selectAll, requestId) => {
    const source = "ALTER ALGORITHM=UNDEFINED DEFINER=`root`@`127.0.0.1` SQL SECURITY DEFINER VIEW `v_format_repro` AS SELECT CASE WHEN 1 THEN REPLACE('a','a','b') END AS `结果`;";
    const { state, emits, host } = mountEditor({ modelValue: source, tabId: "mysql-view" });
    await waitForEditor(host);
    const editorView = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    editorView.dispatch({ selection: { anchor: 0, head: selectAll ? source.length : 0 } });

    state.formatRequestId = requestId;
    await vi.waitFor(() => expect(emits.at(-1)).toContain("\n"), WAIT);

    expect(editorView.state.doc.toString()).toContain("REPLACE('a', 'a', 'b')");
    expect(editorView.state.doc.toString()).toContain("AS `结果`");
    if (selectAll) {
      expect(editorView.state.selection.main.from).toBe(0);
      expect(editorView.state.selection.main.to).toBe(editorView.state.doc.length);
    }
  });
});
