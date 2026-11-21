// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DataCompareDialog from "@/components/diff/DataCompareDialog.vue";
import type { DataCompareSession, DataCompareSessionConfig } from "@/composables/useDataCompareSession";
import { useDataCompareConfig } from "@/composables/useDataCompareConfig";

const mocks = vi.hoisted(() => ({
  session: null as DataCompareSession | null,
  ensureConnected: vi.fn(),
  listDatabases: vi.fn(),
  listSchemas: vi.fn(),
  listTables: vi.fn(),
  getColumns: vi.fn(),
  toast: vi.fn(),
  prepareDataCompareFromTables: vi.fn(),
  buildDataCompareSyncPlan: vi.fn(),
}));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/composables/useDataCompareSession", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/composables/useDataCompareSession")>();
  return { ...original, getDataCompareSession: (id: string | null | undefined) => (id === mocks.session?.id ? mocks.session : original.getDataCompareSession(id)) };
});
vi.mock("@/stores/connectionStore", () => {
  const connections = [1, 2, 3].map((index) => ({ id: `pg-${index}`, name: `PostgreSQL ${index}`, db_type: "postgres" }));
  return {
    useConnectionStore: () => ({
      connections,
      sidebarLayout: { groups: [], order: connections.map(({ id }) => ({ type: "connection", id })) },
      getConfig: (id: string) => connections.find((connection) => connection.id === id),
      ensureConnected: mocks.ensureConnected,
    }),
  };
});
vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
  listSchemas: mocks.listSchemas,
  listTables: mocks.listTables,
  getColumns: mocks.getColumns,
  prepareDataCompareFromTables: mocks.prepareDataCompareFromTables,
  buildDataCompareSyncPlan: mocks.buildDataCompareSyncPlan,
}));

const mountedApps: App[] = [];
const tables = [
  { name: "orders", table_type: "TABLE" },
  { name: "invoices", table_type: "TABLE" },
];

beforeEach(() => {
  mocks.ensureConnected.mockReset().mockResolvedValue(undefined);
  mocks.listDatabases.mockReset().mockResolvedValue([{ name: "app" }]);
  mocks.listSchemas.mockReset().mockResolvedValue(["public", "analytics"]);
  mocks.listTables.mockReset().mockResolvedValue(tables);
  mocks.getColumns.mockReset().mockResolvedValue([{ name: "id", data_type: "integer", is_primary_key: true }]);
  mocks.toast.mockReset();
  mocks.prepareDataCompareFromTables
    .mockReset()
    .mockResolvedValue({ result: { added: [], removed: [], modified: [] }, syncStatements: [], syncSql: "", preSyncStatements: [], sourceRowCount: 0, targetRowCount: 0, sourceTruncated: false, targetTruncated: false, rowBudget: 100000, syncEligible: true });
  mocks.buildDataCompareSyncPlan.mockReset().mockResolvedValue({ insertCount: 0, updateCount: 0, deleteCount: 0, statementCount: 0, syncStatements: [], syncSql: "" });
  const configs = useDataCompareConfig();
  for (const config of configs.configs.value) configs.deleteConfig(config.id);
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  mocks.session = null;
});

async function flushAsyncSetup() {
  for (let index = 0; index < 8; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mountLoadedDialog(overrides: Partial<DataCompareSessionConfig> = {}) {
  mocks.session = {
    id: "loaded-compare",
    version: 1,
    status: "completed",
    config: {
      sourceConnectionId: "pg-1",
      sourceDatabase: "app",
      sourceSchema: "public",
      sourceDatabases: ["app", "reporting"],
      sourceSchemas: ["public", "analytics"],
      sourceTables: ["orders", "invoices"],
      selectedSourceTables: ["orders"],
      targetConnectionId: "pg-2",
      targetDatabase: "reporting",
      targetSchema: "analytics",
      targetDatabases: ["app", "reporting"],
      targetSchemas: ["public", "analytics"],
      targetTables: ["orders", "invoices"],
      targetTable: "invoices",
      keyColumnsByTable: {},
      label: "Loaded comparison",
      ...overrides,
    },
    progress: null,
    batchResults: [],
    syncPlan: { insertCount: 0, updateCount: 0, deleteCount: 0, statementCount: 0, syncStatements: [], syncSql: "" },
    error: null,
    startedAt: 1,
    finishedAt: 2,
  };
  await mountDialog("loaded-compare");
}

async function mountDialog(sessionId: string | null) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(defineComponent({ setup: () => () => h(DataCompareDialog, { open: true, sessionId }) }));
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await flushAsyncSetup();
}

function panel(side: "source" | "target"): HTMLDivElement {
  const color = side === "source" ? "blue" : "emerald";
  return [...document.querySelectorAll<HTMLDivElement>("div")].find((element) => element.classList.contains(`border-${color}-500/35`))!;
}

function namespaceTriggers(side: "source" | "target") {
  return [...panel(side).querySelectorAll<HTMLButtonElement>("button.dbx-searchable-select-trigger")];
}

function swapButton() {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.title === i18n.global.t("diff.swap"))!;
}

async function chooseConnection(side: "source" | "target", id: string) {
  panel(side).querySelector<HTMLButtonElement>("button.dbx-diff-connection-trigger")!.click();
  await flushAsyncSetup();
  document.querySelector<HTMLButtonElement>(`[data-picker-connection="${id}"]`)!.click();
  await flushAsyncSetup();
}

async function chooseOption(trigger: HTMLButtonElement, value: string) {
  trigger.click();
  await flushAsyncSetup();
  [...document.querySelectorAll<HTMLButtonElement>(".dbx-searchable-select-list button")].find((button) => button.textContent?.trim() === value)!.click();
  await flushAsyncSetup();
}

const stages = ["databases", "schemas", "tables"] as const;
type Stage = (typeof stages)[number];

async function beginMetadataLoad(side: "source" | "target", stage: Stage) {
  if (stage === "databases") await chooseConnection(side, "pg-3");
  else if (stage === "schemas") await chooseOption(namespaceTriggers(side)[0], side === "source" ? "reporting" : "app");
  else await chooseOption(namespaceTriggers(side)[1], side === "source" ? "analytics" : "public");
}

function deferredMetadata(stage: Stage) {
  const request = stage === "databases" ? mocks.listDatabases : stage === "schemas" ? mocks.listSchemas : mocks.listTables;
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  request.mockReturnValueOnce(
    new Promise((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    }),
  );
  return {
    resolve: () => resolve(stage === "databases" ? [{ name: "app" }] : stage === "schemas" ? ["public", "analytics"] : tables),
    reject,
  };
}

it.each(["source", "target"].flatMap((side) => stages.map((stage) => [side as "source" | "target", stage] as const)))("waits for pending %s %s before allowing swap", async (side, stage) => {
  await mountLoadedDialog();
  const pending = deferredMetadata(stage);
  await beginMetadataLoad(side, stage);
  expect(swapButton().disabled).toBe(true);
  swapButton().click();
  expect(panel(side).querySelector<HTMLButtonElement>("button.dbx-diff-connection-trigger")!.title).toBe(stage === "databases" ? "PostgreSQL 3" : side === "source" ? "PostgreSQL 1" : "PostgreSQL 2");

  pending.resolve();
  await flushAsyncSetup();
  expect(swapButton().disabled).toBe(false);
  const previousDatabase = namespaceTriggers(side)[0].title;
  expect(namespaceTriggers(side)[0].disabled).toBe(false);
  swapButton().click();
  await flushAsyncSetup();
  const destination = side === "source" ? "target" : "source";
  expect(namespaceTriggers(destination)[0].title).toBe(previousDatabase);
  expect(namespaceTriggers(destination)[0].disabled).toBe(false);
});

it.each(stages)("releases the swap lock after a %s request fails", async (stage) => {
  await mountLoadedDialog();
  const pending = deferredMetadata(stage);
  await beginMetadataLoad("source", stage);
  expect(swapButton().disabled).toBe(true);
  pending.reject(new Error("metadata unavailable"));
  await flushAsyncSetup();
  expect(swapButton().disabled).toBe(false);
  expect(mocks.toast).toHaveBeenCalledWith("Error: metadata unavailable", 5000);
});

it("waits for both endpoints when their requests overlap", async () => {
  await mountLoadedDialog();
  const source = deferredMetadata("databases");
  const target = deferredMetadata("databases");
  await chooseConnection("source", "pg-3");
  await chooseConnection("target", "pg-1");
  source.resolve();
  await flushAsyncSetup();
  expect(swapButton().disabled).toBe(true);
  target.resolve();
  await flushAsyncSetup();
  expect(swapButton().disabled).toBe(false);
});

it("preserves loaded databases, schemas and table selections after swap", async () => {
  await mountLoadedDialog();
  expect(swapButton().disabled).toBe(false);
  swapButton().click();
  await flushAsyncSetup();
  expect(panel("source").querySelector<HTMLButtonElement>("button.dbx-diff-connection-trigger")!.title).toBe("PostgreSQL 2");
  expect(panel("target").querySelector<HTMLButtonElement>("button.dbx-diff-connection-trigger")!.title).toBe("PostgreSQL 1");
  expect(namespaceTriggers("source").map((button) => button.title)).toEqual(["reporting", "analytics"]);
  expect(namespaceTriggers("target").map((button) => button.title)).toEqual(["app", "public", "orders"]);
  expect(panel("source").querySelector('[data-table-name="invoices"] svg')?.classList.contains("text-primary")).toBe(true);
  expect(panel("source").querySelector('[data-table-name="orders"] svg')?.classList.contains("text-primary")).toBe(false);
  expect(mocks.listDatabases).not.toHaveBeenCalled();
  expect(mocks.listSchemas).not.toHaveBeenCalled();
  expect(mocks.listTables).not.toHaveBeenCalled();
});

function advancedButton() {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(i18n.global.t("dataCompare.advancedOptions")))!;
}

function filterInput(side: "source" | "target") {
  const label = [...document.querySelectorAll("label")].find((element) => element.textContent?.includes(i18n.global.t(`dataCompare.${side}Filter`)));
  return label ? (document.getElementById(label.htmlFor) as HTMLTextAreaElement) : null;
}

async function setFilter(side: "source" | "target", value: string) {
  const input = filterInput(side)!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}

it("starts with collapsed advanced options and blank filters for a legacy session", async () => {
  await mountLoadedDialog();
  expect(advancedButton()).toBeDefined();
  expect(advancedButton().getAttribute("aria-expanded")).toBe("false");
  advancedButton().click();
  await nextTick();
  expect(advancedButton().getAttribute("aria-expanded")).toBe("true");
  expect(filterInput("source")?.value).toBe("");
  expect(filterInput("target")?.value).toBe("");
});

it("restores filters visibly and swaps them with their endpoints", async () => {
  await mountLoadedDialog({ sourceFilter: "tenant_id = 1", targetFilter: "tenant_id = 2" });
  expect(advancedButton()?.getAttribute("aria-expanded")).toBe("true");
  expect(filterInput("source")?.value).toBe("tenant_id = 1");
  expect(filterInput("target")?.value).toBe("tenant_id = 2");
  swapButton().click();
  await flushAsyncSetup();
  expect(filterInput("source")?.value).toBe("tenant_id = 2");
  expect(filterInput("target")?.value).toBe("tenant_id = 1");
});

it("sends edited filters, locks them during comparison, and clears stale results on edits", async () => {
  await mountLoadedDialog();
  expect(advancedButton()).toBeDefined();
  advancedButton().click();
  await nextTick();
  await setFilter("source", "id > 10");
  await setFilter("target", "id > 20");
  let finish!: (value: unknown) => void;
  const result = await mocks.prepareDataCompareFromTables();
  mocks.prepareDataCompareFromTables.mockClear().mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(i18n.global.t("dataCompare.compare")))!.click();
  await flushAsyncSetup();
  expect(mocks.prepareDataCompareFromTables).toHaveBeenCalledWith(expect.objectContaining({ sourceFilter: "id > 10", targetFilter: "id > 20" }));
  expect(filterInput("source")?.disabled).toBe(true);
  expect(filterInput("target")?.disabled).toBe(true);
  finish(result);
  await flushAsyncSetup();
  expect(filterInput("source")?.disabled).toBe(false);
  expect(document.body.textContent).toContain(i18n.global.t("dataCompare.noDifferences"));
  await setFilter("source", "id > 30");
  expect(document.body.textContent).not.toContain(i18n.global.t("dataCompare.noDifferences"));
});

it("saves filter edits and restores them when reopening a saved configuration", async () => {
  await mountLoadedDialog({ sourceFilter: "id > 10", targetFilter: "id > 20" });
  document.querySelector<HTMLButtonElement>('[data-testid="data-compare-config-create"]')!.click();
  await nextTick();
  expect(useDataCompareConfig().activeConfig.value).toMatchObject({ sourceFilter: "id > 10", targetFilter: "id > 20" });
  await setFilter("source", "id > 30");
  await setFilter("target", "");
  await vi.waitFor(() => expect(useDataCompareConfig().activeConfig.value).toMatchObject({ sourceFilter: "id > 30", targetFilter: "" }));
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";

  await mountDialog(null);
  expect(advancedButton().getAttribute("aria-expanded")).toBe("true");
  expect(filterInput("source")?.value).toBe("id > 30");
  expect(filterInput("target")?.value).toBe("");
});

it("keeps configured filters active when advanced options are collapsed", async () => {
  await mountLoadedDialog({ sourceFilter: "id > 10", targetFilter: "id > 20" });
  advancedButton().click();
  await nextTick();
  expect(advancedButton().getAttribute("aria-expanded")).toBe("false");
  expect(advancedButton().textContent).toContain(i18n.global.t("dataCompare.filtersActive"));
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(i18n.global.t("dataCompare.compare")))!.click();
  await flushAsyncSetup();
  expect(mocks.prepareDataCompareFromTables).toHaveBeenCalledWith(expect.objectContaining({ sourceFilter: "id > 10", targetFilter: "id > 20" }));
  expect(document.body.textContent).toContain(i18n.global.t("dataCompare.filteredResultsHint"));
});

it.each(["duplicate", "close", "switch"] as const)("persists pending filter edits before %s without waiting for autosave", async (action) => {
  await mountLoadedDialog({ sourceFilter: "id > 1" });
  document.querySelector<HTMLButtonElement>('[data-testid="data-compare-config-create"]')!.click();
  await nextTick();
  const originalId = useDataCompareConfig().activeConfigId.value;
  await setFilter("source", "id > 10");
  if (action === "duplicate") {
    document.querySelector<HTMLButtonElement>('[data-testid="data-compare-config-duplicate"]')!.click();
    await nextTick();
    expect(useDataCompareConfig().activeConfig.value?.sourceFilter).toBe("id > 10");
  } else if (action === "close") {
    for (const app of mountedApps.splice(0)) app.unmount();
  } else {
    document.querySelector<HTMLButtonElement>('[data-testid="data-compare-config-create"]')!.click();
    await nextTick();
  }
  expect(useDataCompareConfig().configs.value.find((config) => config.id === originalId)?.sourceFilter).toBe("id > 10");
});

it("does not overwrite an unrelated saved config when editing a restored session", async () => {
  await mountLoadedDialog({ sourceFilter: "id > 1" });
  document.querySelector<HTMLButtonElement>('[data-testid="data-compare-config-create"]')!.click();
  await nextTick();
  const savedId = useDataCompareConfig().activeConfigId.value;
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";

  await mountLoadedDialog({ sourceFilter: "id > 99" });
  await setFilter("source", "id > 123");
  for (const app of mountedApps.splice(0)) app.unmount();
  expect(useDataCompareConfig().configs.value.find((config) => config.id === savedId)?.sourceFilter).toBe("id > 1");
});

it("locks filters while a saved configuration is loading and saves edits after loading", async () => {
  await mountLoadedDialog({ sourceFilter: "id > 1" });
  document.querySelector<HTMLButtonElement>('[data-testid="data-compare-config-create"]')!.click();
  await nextTick();
  const savedId = useDataCompareConfig().activeConfigId.value;
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  let finish!: (value: unknown) => void;
  mocks.listDatabases.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );

  await mountDialog(null);
  expect(filterInput("source")?.disabled).toBe(true);
  expect(filterInput("target")?.disabled).toBe(true);
  finish([{ name: "app" }]);
  await flushAsyncSetup();
  expect(filterInput("source")?.disabled).toBe(false);
  await setFilter("source", "id > 99");
  for (const app of mountedApps.splice(0)) app.unmount();
  expect(useDataCompareConfig().configs.value.find((config) => config.id === savedId)?.sourceFilter).toBe("id > 99");
});
