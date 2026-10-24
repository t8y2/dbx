// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";

const scriptRuntime = vi.hoisted(() => ({ available: { value: false } as { value: boolean } }));

vi.mock("@/lib/mongo/mongoScriptAvailability", async () => {
  const { ref } = await import("vue");
  const available = ref(false);
  scriptRuntime.available = available;
  return { useMongoScriptAvailable: () => available };
});

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

function mountToolbar(dbType: string) {
  const connectionStore = useConnectionStore();
  connectionStore.connections = [{ id: "conn-1", name: "conn", db_type: dbType, color: "" } as never];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(EditorToolbar, {
    activeTab: {
      id: "tab-1",
      title: "Query",
      connectionId: "conn-1",
      database: "app",
      sql: "db.users.find({})",
      mode: "query",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
    },
    activeConnection: connectionStore.getConfig("conn-1"),
    executableSql: "db.users.find({})",
    explainMode: "explain",
    blockDangerousRedisCommands: false,
    sqlKeywordCase: "preserve",
    databaseRequiredSignal: 0,
    autoCommit: true,
    txnSessionId: undefined,
    txnAutoRolledBack: false,
    txnPossiblyDirty: false,
    stickyProvenReadOnlyState: false,
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} } }));
  app.mount(host);
  return { host, app };
}

let pinia: ReturnType<typeof createPinia>;

describe("EditorToolbar MongoDB script action", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    pinia = createPinia();
    setActivePinia(pinia);
  });

  it.each([
    ["mongodb", true, true],
    ["mongodb", false, false],
    ["mysql", true, false],
  ])("on %s with the runtime available=%s shows the action: %s", async (dbType, available, shown) => {
    scriptRuntime.available.value = available;
    const { host, app } = mountToolbar(dbType);
    await nextTick();

    expect(!!host.querySelector('[data-testid="execute-mongo-script"]')).toBe(shown);

    app.unmount();
    host.remove();
  });
});
