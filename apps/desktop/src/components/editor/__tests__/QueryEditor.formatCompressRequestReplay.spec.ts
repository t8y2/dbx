// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";

import QueryEditor from "@/components/editor/QueryEditor.vue";
import { compressSqlText, formatSqlForEditing } from "@/lib/sql/sqlFormatter";
import { DEFAULT_SQL_FORMATTER_SETTINGS } from "@/lib/sql/sqlFormatterConfig";

// The request ids are per-kind global counters in App.vue, so ids keep
// increasing for the lifetime of the process. The module-scope replay cursor in
// QueryEditor.vue survives across the editor mounts in this file, so every test
// must advance its ids monotonically (never reuse a smaller id) to mirror the
// production counter.
const ORIGINAL_SQL = "select id, name\nfrom users\nwhere id = 1";
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

function mountEditor(initial: { modelValue: string; tabId: string; formatRequestId?: number; compressRequestId?: number }) {
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
        databaseType: "mysql",
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
});
