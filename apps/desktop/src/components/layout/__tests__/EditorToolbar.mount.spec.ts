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

describe("EditorToolbar mount contract", () => {
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

  it("emits toolbarExecute instead of execute when the run button is clicked", async () => {
    const connectionStore = useConnectionStore();
    connectionStore.connections = [
      {
        id: "conn-1",
        name: "conn",
        db_type: "mysql",
        color: "",
      } as never,
    ];

    const host = createHost();
    const onToolbarExecute = vi.fn();
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
      autoCommit: true,
      txnSessionId: undefined,
      txnAutoRolledBack: false,
      oracleTxnPossiblyDirty: false,
      isOracleManualTransaction: false,
      onToolbarExecute,
    });
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    await nextTick();

    const buttons = host.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(0);
    const runButton = buttons[0];
    runButton.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    await nextTick();

    expect(onToolbarExecute).toHaveBeenCalledTimes(1);
    expect(onToolbarExecute.mock.calls[0]?.[0]).toBe("pointer");

    app.unmount();
    host.remove();
  });

  it("mounts for a schema-aware connection whose watchEffect reads tier-gated selectors", async () => {
    // Regression: the tier-gated showSchemaSelector is read eagerly by the
    // schema-loading watchEffect, so the tier refs must be declared before any
    // computed that references them (a Postgres connection takes this branch;
    // MySQL never did, which is why the TDZ crash only reproduced live).
    const connectionStore = useConnectionStore();
    connectionStore.connections = [
      {
        id: "conn-pg",
        name: "pg",
        db_type: "postgres",
        host: "localhost",
        port: 5432,
        username: "root",
        password: "",
      } as never,
    ];

    const host = createHost();
    const errors: unknown[] = [];
    const app = createApp(EditorToolbar, {
      activeTab: {
        id: "tab-pg",
        title: "SQL",
        connectionId: "conn-pg",
        database: "app",
        sql: "SELECT 1",
        mode: "query",
        isExecuting: false,
        isCancelling: false,
        isExplaining: false,
      },
      activeConnection: connectionStore.getConfig("conn-pg"),
      executableSql: "SELECT 1",
      explainMode: "explain",
      blockDangerousRedisCommands: false,
      sqlKeywordCase: "preserve",
      databaseRequiredSignal: 0,
      autoCommit: true,
      txnSessionId: undefined,
      txnAutoRolledBack: false,
      oracleTxnPossiblyDirty: false,
      isOracleManualTransaction: false,
    });
    app.config.errorHandler = (err) => {
      errors.push(err);
    };
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    await nextTick();
    await nextTick();

    expect(errors).toEqual([]);
    expect(host.querySelector(".app-editor-toolbar")).not.toBeNull();

    app.unmount();
    host.remove();
  });
});
