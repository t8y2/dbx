// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/button", () => ({
  Button: { name: "ButtonStub", template: `<button><slot /></button>` },
}));
vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: { name: "SearchableSelectStub", template: `<div />` },
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: { name: "TooltipStub", template: `<span><slot /></span>` },
  TooltipTrigger: { name: "TooltipTriggerStub", template: `<span><slot /></span>` },
  TooltipContent: { name: "TooltipContentStub", template: `<span><slot /></span>` },
}));
vi.mock("@/components/ui/TruncatedTextTooltip.vue", () => ({
  default: { name: "TruncatedTextTooltipStub", template: `<span />` },
}));
vi.mock("@/components/icons/DatabaseIcon.vue", () => ({
  default: { name: "DatabaseIconStub", template: `<span />` },
}));
vi.mock("@/components/connection/ConnectionTreeSelect.vue", () => ({
  default: { name: "ConnectionTreeSelectStub", template: `<div />` },
}));
vi.mock("@/components/common/ProductionContextBadge.vue", () => ({
  default: { name: "ProductionContextBadgeStub", template: `<span />` },
}));

import EditorToolbar from "../EditorToolbar.vue";
import { useConnectionStore } from "@/stores/connectionStore";

describe("EditorToolbar: passive wake-up must not reconnect a user-closed connection", () => {
  let pinia: ReturnType<typeof createPinia>;
  let i18n: ReturnType<typeof createI18n>;
  let host: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    pinia = createPinia();
    setActivePinia(pinia);
    i18n = createI18n({ legacy: false, locale: "en", messages: { en: {} } });
  });

  function mount(state: { connectionId: string; database: string }, ensureSpy: ReturnType<typeof vi.fn>) {
    const connectionStore = useConnectionStore();
    connectionStore.ensureConnected = ensureSpy as never;
    const Host = defineComponent({
      setup: () => () =>
        h(EditorToolbar, {
          activeTab: {
            id: "tab-1",
            title: "SQL",
            connectionId: state.connectionId,
            database: state.database,
            sql: "SELECT 1",
            mode: "query",
            isExecuting: false,
            isCancelling: false,
            isExplaining: false,
          },
          activeConnection: connectionStore.getConfig(state.connectionId),
          executableSql: "SELECT 1",
          explainMode: "explain",
          blockDangerousRedisCommands: false,
          sqlKeywordCase: "preserve",
          databaseRequiredSignal: 0,
          autoCommit: true,
          txnSessionId: undefined,
          txnAutoRolledBack: false,
          txnPossiblyDirty: false,
          stickyProvenReadOnlyState: false,
        }),
    });
    const app = createApp(Host);
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    return app;
  }

  it("does not prefetch options for a connection the user just closed", async () => {
    const connectionStore = useConnectionStore();
    connectionStore.connections = [{ id: "conn-1", name: "conn", db_type: "postgres", database: "app", color: "" } as never];
    const ensureSpy = vi.fn(async () => {});
    const state = reactive({ connectionId: "conn-1", database: "app" });

    // 侧栏「关闭连接」后的状态（写入细节由 connectionStore.userClosedConnection.spec 覆盖）。
    connectionStore.userClosedConnectionIds = new Set(["conn-1"]);
    expect(connectionStore.isConnectionClosedByUser("conn-1")).toBe(true);

    const app = mount(state, ensureSpy);
    await nextTick();
    await Promise.resolve();
    expect(ensureSpy).not.toHaveBeenCalled();

    // 切到同一连接下另一个库（页签切换的老重现路径）也不该唤醒连接。
    state.database = "other_db";
    await nextTick();
    await Promise.resolve();
    expect(ensureSpy).not.toHaveBeenCalled();

    app.unmount();
  }, 20_000);

  it("prefetches again once the user reconnects", async () => {
    const connectionStore = useConnectionStore();
    connectionStore.connections = [{ id: "conn-1", name: "conn", db_type: "postgres", database: "app", color: "" } as never];
    const ensureSpy = vi.fn(async () => {});
    const state = reactive({ connectionId: "conn-1", database: "app" });

    connectionStore.userClosedConnectionIds = new Set(["conn-1"]);
    const app = mount(state, ensureSpy);
    await nextTick();
    await Promise.resolve();
    expect(ensureSpy).not.toHaveBeenCalled();

    // 用户显式重连会清掉标记（见 connectionStore.userClosedConnection.spec）。
    connectionStore.userClosedConnectionIds = new Set();
    connectionStore.connectedIds.add("conn-1");
    await nextTick();
    await Promise.resolve();

    expect(ensureSpy).toHaveBeenCalled();
    expect(ensureSpy.mock.calls.every((call) => call[0] === "conn-1")).toBe(true);

    app.unmount();
  }, 20_000);
});
