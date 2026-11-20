// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QueryHistory from "../QueryHistory.vue";

const mocks = vi.hoisted(() => {
  const base = {
    connection_id: "dm-test",
    connection_name: "Dameng test",
    database: "SYSDBA",
    sql: "",
    execution_time_ms: 3,
    executed_at: "2026-01-01T00:00:00Z",
    success: true,
    activity_kind: "query",
    source: "mcp",
    mcp_response_json: JSON.stringify({ content: [] }),
  };
  return {
    entries: [
      { ...base, id: "mcp-sql", operation: "dbx_execute_query", mcp_tool_name: "dbx_execute_query", mcp_request_json: JSON.stringify({ connection: "dm-test", sql: "SELECT id FROM users WHERE active = 1" }) },
      { ...base, id: "mcp-list", operation: "dbx_list_tables", mcp_tool_name: "dbx_list_tables", mcp_request_json: JSON.stringify({ connection: "dm-test" }) },
    ],
  };
});

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/historyStore", () => ({
  useHistoryStore: () => ({
    entries: mocks.entries,
    connectionOptions: [],
    total: mocks.entries.length,
    loading: false,
    error: "",
    nextCursor: null,
    setHistoryPanelActive: vi.fn(),
    loadConnectionOptions: vi.fn().mockResolvedValue(undefined),
    search: vi.fn(),
  }),
}));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: () => ({ id: "dm-test", db_type: "dameng" }) }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (text: string) => `<span class="hl">${text}</span>` }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionSqlGuard: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({}));
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    props: ["items"],
    setup:
      (props, { slots }) =>
      () =>
        h(
          "div",
          props.items.map((item: unknown) => slots.default?.({ item })),
        ),
  }),
}));
vi.mock("@/components/ui/CustomContextMenu.vue", () => ({
  default: defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.({ onContextMenu: vi.fn(), isOpen: false })),
  }),
}));

let app: App | undefined;

async function openDetails(toolName: string) {
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp(QueryHistory, { onClose: vi.fn() });
  app.mount(root);
  await nextTick();
  const row = [...document.querySelectorAll<HTMLDivElement>("div")].find((item) => item.classList.contains("cursor-pointer") && item.textContent?.includes(toolName));
  expect(row).toBeDefined();
  row!.click();
  await nextTick();
  await vi.waitFor(() => expect(document.querySelector("pre")).not.toBeNull());
}

function sqlBlocks() {
  return [...document.querySelectorAll<HTMLPreElement>("pre.max-h-48")];
}

beforeEach(() => {
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
});
afterEach(async () => {
  app?.unmount();
  app = undefined;
  await nextTick();
  document.body.textContent = "";
  vi.unstubAllGlobals();
});

describe("QueryHistory MCP call detail", () => {
  it("shows the SQL of the call in its own highlighted block above the request", async () => {
    await openDetails("dbx_execute_query");

    const blocks = sqlBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.innerHTML).toBe('<span class="hl">SELECT id FROM users WHERE active = 1</span>');
    const request = [...document.querySelectorAll<HTMLPreElement>("pre")].find((item) => item.textContent?.includes('"connection"'));
    expect(request).toBeDefined();
    expect(blocks[0]!.compareDocumentPosition(request!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.body.textContent).toContain("history.copy");
  });

  it("hides the SQL block for a call that carries no SQL", async () => {
    await openDetails("dbx_list_tables");

    expect(sqlBlocks()).toHaveLength(0);
    expect([...document.querySelectorAll<HTMLPreElement>("pre")].some((item) => item.textContent?.includes('"connection"'))).toBe(true);
  });
});
