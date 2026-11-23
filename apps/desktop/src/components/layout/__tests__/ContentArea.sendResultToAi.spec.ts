// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, defineComponent, h, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryTab } from "@/types/database";

vi.mock("@/components/editor/QueryEditor.vue", () => ({ __esModule: true, default: { render: () => null } }));
vi.mock("@/components/transfer/QueryResultTransferDialog.vue", () => ({ __esModule: true, default: { render: () => null } }));
vi.mock("@/components/grid/DataGridExportMenu.vue", () => ({ __esModule: true, default: { render: () => null } }));
// The real grid hosts the result toolbar slot and owns the context-menu entry
// that emits `sendResultToAi`; the mock exposes both so the content area wiring
// can be exercised without mounting the 14k-line grid.
vi.mock("@/components/grid/DataGrid.vue", () => ({
  __esModule: true,
  default: defineComponent({
    props: {
      result: { type: Object, default: undefined },
      // Boolean cast matters: ContentArea passes the attribute shorthand, which
      // only becomes `true` when the prop is declared as a Boolean.
      sendResultToAiEnabled: Boolean,
    },
    emits: ["sendResultToAi"],
    setup(props, { slots, emit }) {
      return () => h("div", { "data-test": "data-grid", "data-send-result-to-ai-enabled": String(props.sendResultToAiEnabled) }, [h("button", { "data-test": "grid-send-result-to-ai", onClick: () => emit("sendResultToAi") }), slots["result-toolbar-actions"]?.({ compact: false })]);
    },
  }),
}));

import ContentArea from "../ContentArea.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  window.localStorage?.clear();
  vi.clearAllMocks();
});

function result(overrides: Partial<QueryResult> = {}): QueryResult {
  return { columns: ["ID", "NAME"], rows: [[1, "alice"]], affected_rows: 0, execution_time_ms: 1, ...overrides };
}

async function mountContentArea(resultValue: QueryResult, onSendResultToAi: (tabId: string) => void) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = { id: "mysql-1", name: "MySQL", db_type: "mysql" as const, host: "localhost", port: 3306, username: "root", password: "" };
  useConnectionStore().connections = [connection];
  const tab = reactive<QueryTab>({
    id: "query-tab-1",
    title: "Query 1",
    connectionId: connection.id,
    database: "app",
    mode: "query",
    sql: "SELECT * FROM users",
    isExecuting: false,
    result: resultValue,
    activeResultIndex: 0,
  });
  useQueryStore().tabs.push(tab);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({
    render: () => h(ContentArea, { activeTab: tab, activeConnection: connection, activeOutputView: "result", executableSql: "", formatSqlRequest: null, compressSqlRequest: null, selectedSql: "", cursorPos: 0, resultOnly: true, blockDangerousRedisCommands: false, onSendResultToAi }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => app.unmount());
  return host;
}

describe("ContentArea send result to AI", () => {
  it("does not render the removed toolbar action for a tabular result", async () => {
    const host = await mountContentArea(result(), () => {});
    await vi.waitFor(() => expect(host.querySelector("[data-test=data-grid]")).not.toBeNull());
    expect(host.querySelector("[data-query-result-send-ai]")).toBeNull();
  });

  it("forwards the grid surface's sendResultToAi event with the tab id", async () => {
    const sends: string[] = [];
    const host = await mountContentArea(result(), (tabId) => sends.push(tabId));

    // Both result grid instances listen to the event, so both must opt in to
    // rendering the context-menu entry.
    const grids = await vi.waitFor(() => {
      const elements = [...host.querySelectorAll<HTMLElement>("[data-test=data-grid]")];
      expect(elements.length).toBeGreaterThan(0);
      return elements;
    });
    expect(grids.map((grid) => grid.dataset.sendResultToAiEnabled)).toEqual(grids.map(() => "true"));

    const button = host.querySelector<HTMLButtonElement>("[data-test=grid-send-result-to-ai]");
    expect(button).not.toBeNull();
    button!.click();
    expect(sends).toEqual(["query-tab-1"]);
  });

  it("opts every sendResultToAi listener into the grid entry", async () => {
    // Only one of the two query-result grids is mounted per output view, so the
    // other instance is pinned at source level: the self-closing tag that
    // listens to `sendResultToAi` must also carry the enabling prop, or that
    // grid would offer a dead menu item.
    // happy-dom resolves `new URL(..., import.meta.url)` against the dev-server
    // base, so the source path must come from the real file URL.
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../ContentArea.vue"), "utf8");
    const listenerIndexes = [...source.matchAll(/@send-result-to-ai=/g)].map((match) => match.index);
    expect(listenerIndexes.length).toBeGreaterThan(0);
    for (const index of listenerIndexes) {
      const tagEnd = source.indexOf("/>", index);
      expect(tagEnd).toBeGreaterThan(index);
      expect(source.slice(index, tagEnd)).toContain("send-result-to-ai-enabled");
    }
  });

  it("keeps the toolbar entry absent for error and empty results", async () => {
    const errorHost = await mountContentArea(result({ execution_error: true, rows: [["boom"]] }), () => {});
    await vi.waitFor(() => expect(errorHost.querySelector("[data-test=data-grid]")).not.toBeNull());
    expect(errorHost.querySelector("[data-query-result-send-ai]")).toBeNull();

    const emptyHost = await mountContentArea(result({ rows: [] }), () => {});
    await vi.waitFor(() => expect(emptyHost.querySelector("[data-test=data-grid]")).not.toBeNull());
    expect(emptyHost.querySelector("[data-query-result-send-ai]")).toBeNull();
  });
});
