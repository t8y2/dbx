// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/button", () => ({
  Button: {
    name: "ButtonStub",
    template: `<button><slot /></button>`,
  },
}));

vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: {
    name: "SearchableSelectStub",
    template: `<div />`,
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: {
    name: "TooltipStub",
    template: `<span><slot /></span>`,
  },
  TooltipTrigger: {
    name: "TooltipTriggerStub",
    template: `<span><slot /></span>`,
  },
  TooltipContent: {
    name: "TooltipContentStub",
    template: `<span><slot /></span>`,
  },
}));

vi.mock("@/components/ui/TruncatedTextTooltip.vue", () => ({
  default: {
    name: "TruncatedTextTooltipStub",
    template: `<span />`,
  },
}));

vi.mock("@/components/icons/DatabaseIcon.vue", () => ({
  default: {
    name: "DatabaseIconStub",
    template: `<span />`,
  },
}));

vi.mock("@/components/connection/ConnectionTreeSelect.vue", () => ({
  default: {
    name: "ConnectionTreeSelectStub",
    template: `<div />`,
  },
}));

vi.mock("@/components/common/ProductionContextBadge.vue", () => ({
  default: {
    name: "ProductionContextBadgeStub",
    template: `<span />`,
  },
}));

import EditorToolbar from "../EditorToolbar.vue";
import { useConnectionStore } from "@/stores/connectionStore";

function createHost(): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

describe("EditorToolbar commit/rollback visibility", () => {
  let pinia: ReturnType<typeof createPinia>;
  let i18n: ReturnType<typeof createI18n>;

  beforeEach(() => {
    document.body.innerHTML = "";
    pinia = createPinia();
    setActivePinia(pinia);
    i18n = createI18n({
      legacy: false,
      locale: "en",
      messages: { en: {} },
    });
  });

  async function mountToolbar(props: { dbType: string; stickyProvenReadOnlyState: boolean; txnPossiblyDirty?: boolean; txnSessionId?: string }) {
    const connectionStore = useConnectionStore();
    connectionStore.connections = [
      {
        id: "conn-1",
        name: "conn",
        db_type: props.dbType,
        color: "",
      } as never,
    ];

    const host = createHost();
    const app = createApp(EditorToolbar, {
      activeTab: {
        id: "tab-1",
        title: "SQL",
        connectionId: "conn-1",
        database: "db",
        sql: "SELECT 1",
        mode: "query",
        isExecuting: false,
        isCancelling: false,
        isExplaining: false,
      },
      activeConnection: connectionStore.getConfig("conn-1"),
      executableSql: "SELECT 1",
      explainMode: "explain",
      blockDangerousRedisCommands: false,
      sqlKeywordCase: "preserve",
      databaseRequiredSignal: 0,
      autoCommit: false,
      txnSessionId: props.txnSessionId,
      txnAutoRolledBack: false,
      txnPossiblyDirty: props.txnPossiblyDirty,
      stickyProvenReadOnlyState: props.stickyProvenReadOnlyState,
    });
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    await nextTick();
    return host;
  }

  const commitSelector = `button[aria-label="toolbar.commit"]`;
  const rollbackSelector = `button[aria-label="toolbar.rollback"]`;

  it("hides Commit/Rollback for a clean MySQL sticky manual session", async () => {
    const host = await mountToolbar({ dbType: "mysql", stickyProvenReadOnlyState: true, txnPossiblyDirty: false, txnSessionId: "txn-1" });

    expect(host.querySelector(commitSelector)).toBeNull();
    expect(host.querySelector(rollbackSelector)).toBeNull();
    host.remove();
  });

  it("shows Commit/Rollback once the MySQL sticky session is dirty", async () => {
    const host = await mountToolbar({ dbType: "mysql", stickyProvenReadOnlyState: true, txnPossiblyDirty: true, txnSessionId: "txn-1" });

    expect(host.querySelector(commitSelector)).not.toBeNull();
    expect(host.querySelector(rollbackSelector)).not.toBeNull();
    host.remove();
  });

  it("keeps the legacy always-visible rule for non-sticky dialects with a session", async () => {
    const host = await mountToolbar({ dbType: "jdbc", stickyProvenReadOnlyState: false, txnPossiblyDirty: false, txnSessionId: "txn-1" });

    expect(host.querySelector(commitSelector)).not.toBeNull();
    expect(host.querySelector(rollbackSelector)).not.toBeNull();
    host.remove();
  });
});
