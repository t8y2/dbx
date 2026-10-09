// @vitest-environment happy-dom
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend/api", () => ({ executeQuery: vi.fn().mockResolvedValue({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 }), cancelQuery: vi.fn().mockResolvedValue(true), listSchemas: vi.fn().mockResolvedValue([]), listDatabases: vi.fn().mockResolvedValue([]) }));
vi.mock("@/components/ui/button", () => ({ Button: { template: `<button><slot /></button>` } }));
vi.mock("@/components/ui/searchable-select", () => ({ SearchableSelect: { template: `<div />` } }));
vi.mock("@/components/ui/tooltip", () => ({ Tooltip: { template: `<span><slot /></span>` }, TooltipTrigger: { template: `<span><slot /></span>` }, TooltipContent: { template: `<span><slot /></span>` } }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: { props: ["open"], template: `<div v-if="open"><slot /></div>` },
  DialogContent: { template: `<section><slot /></section>` },
  DialogHeader: { template: `<header><slot /></header>` },
  DialogTitle: { template: `<h2><slot /></h2>` },
  DialogDescription: { template: `<p><slot /></p>` },
}));
vi.mock("@/components/ui/TruncatedTextTooltip.vue", () => ({ default: { template: `<span />` } }));
vi.mock("@/components/icons/DatabaseIcon.vue", () => ({ default: { template: `<span />` } }));
vi.mock("@/components/connection/ConnectionTreeSelect.vue", () => ({ default: { template: `<div />` } }));
vi.mock("@/components/common/ProductionContextBadge.vue", () => ({ default: { template: `<span />` } }));

import EditorToolbar from "../EditorToolbar.vue";
import SessionBlockingMonitor from "@/components/editor/SessionBlockingMonitor.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/backend/api";
import type { ConnectionConfig } from "@/types/database";

const mounted: App[] = [];
let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => {
  mounted.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = "";
});

async function mount(dbType: string, profile: string, toolbar = true) {
  const connection = { id: "one", name: "dedicated", db_type: dbType, driver_profile: profile, driver_label: `Driver ${profile}`, color: "" } as ConnectionConfig;
  const store = useConnectionStore();
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const app = toolbar
    ? createApp(EditorToolbar, {
        activeTab: { id: "tab", title: "SQL", connectionId: "one", database: "db", sql: "SELECT 1", mode: "query", isExecuting: false, isCancelling: false, isExplaining: false },
        activeConnection: connection,
        executableSql: "SELECT 1",
        sqlKeywordCase: "preserve",
        autoCommit: true,
      } as never)
    : createApp(SessionBlockingMonitor, { connection, database: "db" });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en-US", messages: { "en-US": {} } }));
  app.mount(host);
  mounted.push(app);
  await nextTick();
  return host;
}
async function openAndRefresh(host: HTMLElement) {
  host.querySelector<HTMLButtonElement>('button[aria-label="Sessions and blockers"]')!.click();
  await nextTick();
  const refresh = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Refresh")!;
  refresh.click();
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await nextTick();
  }
  return refresh;
}

describe("real toolbar and monitor database capability", () => {
  it.each(["oci", "oracle", "jdbc"])("keeps Oracle monitoring independent of driver profile %s", async (profile) => {
    const host = await mount("oracle", profile);
    expect(host.querySelector('button[aria-label="Sessions and blockers"]')).not.toBeNull();
    await openAndRefresh(host);
    expect(host.textContent).toContain(`Driver ${profile}`);
    expect(host.textContent).toContain(profile);
    expect(api.executeQuery).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.executeQuery).mock.calls[0][2]).toContain("FROM GV$SESSION");
    expect(vi.mocked(api.executeQuery).mock.calls[0][3]).toBeUndefined();
  });
  it.each(["mysql", "postgres", "jdbc"])("rejects non-Oracle %s even if its display profile says oracle", async (dbType) => {
    const host = await mount(dbType, "oracle");
    expect(host.querySelector('button[aria-label="Sessions and blockers"]')).toBeNull();
    expect(api.executeQuery).not.toHaveBeenCalled();
  });
  it("also rejects a non-Oracle connection passed directly to the real monitor component", async () => {
    const host = await mount("mysql", "oci", false);
    const refresh = await openAndRefresh(host);
    expect(refresh.disabled).toBe(true);
    expect(api.executeQuery).not.toHaveBeenCalled();
  });
});
