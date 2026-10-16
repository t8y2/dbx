// @vitest-environment happy-dom

import { createApp, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

const mocks = vi.hoisted(() => ({
  openDataCompare: vi.fn(),
  openSchemaDiff: vi.fn(),
  openSchemaDiagram: vi.fn(),
}));

vi.mock("@/composables/useDialogSources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useDialogSources")>();
  return {
    ...actual,
    openDataCompareDialogWithState: mocks.openDataCompare,
    openSchemaDiffDialogWithState: mocks.openSchemaDiff,
    openSchemaDiagramDialogWithState: mocks.openSchemaDiagram,
  };
});

import EditorGroupTabBar from "@/components/layout/EditorGroupTabBar.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { QueryTab } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function makeTab(mode: QueryTab["mode"], overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: `tab-${mode}`,
    title: mode,
    connectionId: "conn-1",
    database: "db",
    sql: "",
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
    mode,
    ...overrides,
  } as QueryTab;
}

const mountedApps: App[] = [];

async function mountTabBar(tabs: QueryTab[]) {
  const { useQueryStore } = await import("@/stores/queryStore");
  const store = useQueryStore();
  for (const tab of tabs) {
    // registerOpenTab side effects are irrelevant here; seed directly.
    store.tabs.push(tab);
  }
  store.activeTabId = tabs[0]?.id ?? null;

  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({
    setup: () => () =>
      h(TooltipProvider, { delayDuration: 0 }, () =>
        h(EditorGroupTabBar as never, {
          groupId: "main",
          tabs,
          activeTabId: tabs[0]?.id ?? null,
        }),
      ),
  });
  mountedApps.push(app);
  app.use(i18n);
  // Reuse the pinia the store was seeded on (setActivePinia in beforeEach).
  app.use((await import("pinia")).getActivePinia()!);
  app.mount(container);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return store;
}

beforeEach(() => {
  installLocalStorage();
  setActivePinia(createPinia());
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("EditorGroupTabBar dialog-back icon", () => {
  it("shows the convert icon only on dual-form tabs and converts via the dialog source", async () => {
    const store = await mountTabBar([makeTab("query"), makeTab("schema-diff", { schemaDiffState: { config: { sourceConnectionId: "a", sourceDatabase: "b", sourceSchema: "", targetConnectionId: "c", targetDatabase: "d", targetSchema: "" } } })]);

    const convertButtons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.title === i18n.global.t("workspace.convertToDialog"));
    // query tab has no icon; schema-diff tab has exactly one.
    expect(convertButtons).toHaveLength(1);
    convertButtons[0]!.click();
    await nextTick();

    expect(mocks.openSchemaDiff).toHaveBeenCalledTimes(1);
    // The tab closes after conversion.
    expect(store.tabs.find((tab) => tab.mode === "schema-diff")).toBeUndefined();
  }, 60_000);

  it("keeps the icon disabled for a data-compare tab with a pending transaction", async () => {
    await mountTabBar([makeTab("data-compare", { txnSessionId: "txn-1" })]);
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.title === i18n.global.t("workspace.runStateLockedHint"));
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(true);
    button!.click();
    await nextTick();
    expect(mocks.openDataCompare).not.toHaveBeenCalled();
  }, 60_000);

  it("converts a schema-diagram tab with config only (no scope leak into the dialog)", async () => {
    await mountTabBar([makeTab("schema-diagram", { schemaDiagramState: { config: { connectionId: "conn-1", database: "db", schema: "public" }, scopeId: "tab-xyz" } })]);
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.title === i18n.global.t("workspace.convertToDialog"));
    expect(button).toBeDefined();
    button!.click();
    await nextTick();
    expect(mocks.openSchemaDiagram).toHaveBeenCalledWith({ config: { connectionId: "conn-1", database: "db", schema: "public" } });
  }, 60_000);
});
