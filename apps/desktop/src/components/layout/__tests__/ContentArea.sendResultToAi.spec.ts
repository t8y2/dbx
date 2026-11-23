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

    // The query-result grid must opt in to rendering the context-menu entry, or
    // it would offer a dead menu item.
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

  it("enables the grid entry only on the SQL query-result surface", async () => {
    // Only the active tab's grid is mounted, so the data-tab grid is pinned at
    // source level. The feature is scoped to the SQL query result: a table data
    // page has no query the user ran, so its grid must neither listen to nor
    // enable the entry (the page tag is identified by `context="table-data"`).
    // happy-dom resolves `new URL(..., import.meta.url)` against the dev-server
    // base, so the source path must come from the real file URL.
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../ContentArea.vue"), "utf8");

    function dataGridOpeningTag(attributeIndex: number): string {
      const start = source.lastIndexOf("<DataGrid", attributeIndex);
      expect(start).toBeGreaterThan(-1);
      // These tags are not self-closing and their attribute values contain `>`
      // (arrow functions), so the end must be found quote-aware.
      let quote: string | null = null;
      for (let index = start + "<DataGrid".length; index < source.length; index += 1) {
        const char = source[index];
        if (quote) {
          if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
          quote = char;
        } else if (char === ">") {
          return source.slice(start, index + 1);
        }
      }
      throw new Error("unterminated DataGrid tag");
    }

    const listenerIndexes = [...source.matchAll(/@send-result-to-ai=/g)].map((match) => match.index!);
    expect(listenerIndexes.length).toBe(1);
    const listenerTag = dataGridOpeningTag(listenerIndexes[0]);
    expect(listenerTag).toContain("@send-result-to-ai=");
    expect(listenerTag).toContain("send-result-to-ai-enabled");
    // Sanity-pin that the single listener is the query-result grid.
    expect(listenerTag).toContain('context="results"');

    const tableDataAttributeIndex = source.indexOf('context="table-data"');
    expect(tableDataAttributeIndex).toBeGreaterThan(-1);
    const tableDataTag = dataGridOpeningTag(tableDataAttributeIndex);
    expect(tableDataTag).toContain('context="table-data"');
    expect(tableDataTag).not.toContain("@send-result-to-ai");
    expect(tableDataTag).not.toContain("send-result-to-ai-enabled");
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
