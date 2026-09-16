// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_STATUS_SQL, GLOBAL_VARIABLES_SQL } from "@/lib/database/mysqlServerStatus";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: () => ({ name: "MySQL" }),
  }),
}));
vi.mock("@/lib/backend/api", () => ({ executeQuery: mocks.executeQuery }));
vi.mock("@/composables/useVerticalOverlayScrollbar", async () => {
  const { ref } = await import("vue");
  return {
    useVerticalOverlayScrollbar: () => ({
      hasOverflow: ref(false),
      isScrolling: ref(false),
      isDragging: ref(false),
      thumbStyle: ref({}),
      onScroll: vi.fn(),
      onTrackPointerDown: vi.fn(),
      onThumbPointerDown: vi.fn(),
    }),
  };
});
vi.mock("@lucide/vue", async () => {
  const { defineComponent, h } = await import("vue");
  const Icon = defineComponent({ setup: () => () => h("i") });
  return { Activity: Icon, ArrowDownUp: Icon, ChevronRight: Icon, Database: Icon, Gauge: Icon, Loader2: Icon, RefreshCcw: Icon, Search: Icon, Timer: Icon, TriangleAlert: Icon, Users: Icon };
});

async function passthroughComponent() {
  const { defineComponent, h } = await import("vue");
  return defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
}

vi.mock("@/components/ui/button", async () => ({ Button: await passthroughComponent() }));
vi.mock("@/components/ui/badge", async () => ({ Badge: await passthroughComponent() }));
vi.mock("@/components/ui/select", async () => {
  const component = await passthroughComponent();
  return { Select: component, SelectContent: component, SelectItem: component, SelectTrigger: component, SelectValue: component };
});
vi.mock("@/components/common/MetricCard.vue", async () => ({ default: await passthroughComponent() }));
vi.mock("@/components/chart/MetricLineChart.vue", async () => ({ default: await passthroughComponent() }));

import MySqlDashboard from "@/components/admin/MySqlDashboard.vue";

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushMountedPolling() {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    await nextTick();
  }
}

beforeEach(() => {
  mocks.ensureConnected.mockReset().mockResolvedValue(undefined);
  mocks.executeQuery.mockReset().mockImplementation(async (_connectionId: string, _database: string, sql: string) => ({
    columns: ["Variable_name", "Value"],
    rows: sql === GLOBAL_STATUS_SQL ? [["Queries", "10"]] : [["version", "8.0.11"]],
    affected_rows: 0,
    execution_time_ms: 0,
  }));
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
  document.body.innerHTML = "";
});

describe("MySqlDashboard session affinity", () => {
  it("uses the dashboard tab session for status and variable polling", async () => {
    app = createApp(MySqlDashboard, { connectionId: "mysql-1", clientSessionId: "tab-dashboard" });
    app.mount(root!);
    await flushMountedPolling();

    expect(mocks.ensureConnected).toHaveBeenCalledWith("mysql-1");
    expect(mocks.executeQuery).toHaveBeenNthCalledWith(1, "mysql-1", "", GLOBAL_STATUS_SQL, undefined, undefined, { maxRows: 2000, clientSessionId: "tab-dashboard" });
    expect(mocks.executeQuery).toHaveBeenNthCalledWith(2, "mysql-1", "", GLOBAL_VARIABLES_SQL, undefined, undefined, { maxRows: 2000, clientSessionId: "tab-dashboard" });
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
  });
});
