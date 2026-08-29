// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DataCompareDialog from "@/components/diff/DataCompareDialog.vue";

const SOURCE_CONNECTION_ID = "src-conn-id";
const TARGET_CONNECTION_ID = "tgt-conn-id";
const DATABASE = "DBX_TEST";
const SCHEMA = "DBX_TEST";
const RAW_IGNORED_COLUMNS_INPUT = " created_at , , updated_at ";
const PARSED_IGNORED_COLUMNS = ["created_at", "updated_at"];

const mocks = vi.hoisted(() => {
  // Mutable per-test configuration: the tables returned for the target connection,
  // plus an optional per-table getColumns override for tables with different
  // column sets (tables absent from the map use the default three-column list).
  const state = {
    targetTables: ["ALPHA", "BETA"] as string[],
    tableColumns: {} as Record<string, Array<{ name: string; data_type: string; is_primary_key: boolean }>>,
  };

  const emptyPreparation = (overrides: Record<string, unknown> = {}) => ({
    result: { added: [], removed: [], modified: [] },
    syncStatements: [] as string[],
    syncSql: "",
    preSyncStatements: [] as string[],
    sourceRowCount: 2,
    targetRowCount: 2,
    sourceTruncated: false,
    targetTruncated: false,
    ...overrides,
  });

  return {
    state,
    ensureConnected: vi.fn(async () => undefined),
    listDatabases: vi.fn(async () => [{ name: "DBX_TEST" }]),
    listSchemas: vi.fn(async () => ["DBX_TEST"]),
    listTables: vi.fn(async (connectionId: string) => {
      const names = connectionId === "tgt-conn-id" ? state.targetTables : ["ALPHA", "BETA"];
      return names.map((name) => ({ name, table_type: "TABLE" }));
    }),
    getColumns: vi.fn(async (_connectionId: string, _database: string, _schema: string, table: string) => {
      const override = state.tableColumns[table];
      if (override) return override;
      return [
        { name: "ID", data_type: "NUMBER", is_primary_key: true },
        { name: "CREATED_AT", data_type: "TIMESTAMP", is_primary_key: false },
        { name: "UPDATED_AT", data_type: "TIMESTAMP", is_primary_key: false },
      ];
    }),
    prepareDataCompareFromTables: vi.fn(async (_options: Record<string, unknown>) => emptyPreparation()),
    prepareDataCompareMissingTarget: vi.fn(async (_options: Record<string, unknown>) => emptyPreparation({ targetRowCount: 0 })),
    buildDataCompareSyncPlan: vi.fn(async () => ({ insertCount: 0, updateCount: 0, deleteCount: 0, statementCount: 0, syncStatements: [] as string[], syncSql: "" })),
  };
});

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connections: [
      { id: "src-conn-id", name: "Source Oracle", db_type: "oracle", driver_profile: "oracle", database: "XE" },
      { id: "tgt-conn-id", name: "Target Oracle", db_type: "oracle", driver_profile: "oracle", database: "XE" },
    ],
    getConfig: (id: string) => (id === "src-conn-id" || id === "tgt-conn-id" ? { id, name: id, db_type: "oracle", driver_profile: "oracle", database: "XE" } : undefined),
    ensureConnected: mocks.ensureConnected,
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
  listSchemas: mocks.listSchemas,
  listTables: mocks.listTables,
  getColumns: mocks.getColumns,
  prepareDataCompareFromTables: mocks.prepareDataCompareFromTables,
  prepareDataCompareMissingTarget: mocks.prepareDataCompareMissingTarget,
  buildDataCompareSyncPlan: mocks.buildDataCompareSyncPlan,
}));

const mountedApps: App[] = [];

async function flushAsyncSetup() {
  for (let index = 0; index < 8; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function translate(key: string): string {
  return (i18n.global as unknown as { t: (key: string) => string }).t(key);
}

// Trade-off: the connection/schema/table pickers are reka-ui popovers that are
// hard to drive reliably in happy-dom, so connection ids and the source table
// selection are set through the component's setup state; the text inputs and
// the compare button are exercised through real DOM events (user semantics).
function dialogSetupState(app: App): Record<string, any> {
  const wrapperInstance = (app as unknown as { _instance?: { subTree?: { component?: { setupState?: Record<string, any> } } } })._instance;
  const setupState = wrapperInstance?.subTree?.component?.setupState;
  if (!setupState) throw new Error("DataCompareDialog setup state not found");
  return setupState;
}

async function mountOpenDialog(props: Record<string, unknown> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () => h(DataCompareDialog, { open: true, ...props }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await flushAsyncSetup();
  return app;
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function findInputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-slot="input"]')).find((candidate) => candidate.placeholder === placeholder);
  if (!input) throw new Error(`Input with placeholder "${placeholder}" not rendered`);
  return input;
}

function findButtonByLabel(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((candidate) => (candidate.textContent ?? "").trim() === label);
  if (!button) throw new Error(`Button with label "${label}" not rendered`);
  return button;
}

async function typeIgnoredColumns(app: App) {
  const ignoredInput = findInputByPlaceholder(translate("dataCompare.ignoredColumnsPlaceholder"));
  setNativeInputValue(ignoredInput, RAW_IGNORED_COLUMNS_INPUT);
  // The shadcn Input bridges the native input event to v-model asynchronously.
  await flushAsyncSetup();
  return dialogSetupState(app);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.targetTables = ["ALPHA", "BETA"];
  mocks.state.tableColumns = {};
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("DataCompareDialog ignored columns", () => {
  it("trims entries and drops empty ones from the ignored columns input in the single-table payload", async () => {
    const app = await mountOpenDialog({
      prefillConnectionId: SOURCE_CONNECTION_ID,
      prefillDatabase: DATABASE,
      prefillSchema: SCHEMA,
      prefillTable: "ALPHA",
    });
    const setupState = dialogSetupState(app);
    setupState.targetConnectionId = TARGET_CONNECTION_ID;
    await flushAsyncSetup();

    const stateAfterTyping = await typeIgnoredColumns(app);
    expect(stateAfterTyping.ignoredColumns).toEqual(PARSED_IGNORED_COLUMNS);

    const compareButton = findButtonByLabel(translate("dataCompare.compare"));
    expect(compareButton.disabled).toBe(false);
    compareButton.click();
    await flushAsyncSetup();

    expect(mocks.prepareDataCompareFromTables).toHaveBeenCalledTimes(1);
    const payload = mocks.prepareDataCompareFromTables.mock.calls[0][0];
    expect(payload.sourceTable).toBe("ALPHA");
    expect(payload.targetTable).toBe("ALPHA");
    expect(payload.keyColumns).toEqual(["ID"]);
    expect(payload.ignoredColumns).toEqual(PARSED_IGNORED_COLUMNS);
    expect(mocks.prepareDataCompareMissingTarget).not.toHaveBeenCalled();
  });

  it("sends the same parsed ignored columns with every batch compare request", async () => {
    const app = await mountOpenDialog();
    const setupState = dialogSetupState(app);
    setupState.sourceConnectionId = SOURCE_CONNECTION_ID;
    await flushAsyncSetup();
    setupState.targetConnectionId = TARGET_CONNECTION_ID;
    await flushAsyncSetup();
    setupState.sourceTableSelection = ["ALPHA", "BETA"];
    await flushAsyncSetup();

    await typeIgnoredColumns(app);

    const compareButton = findButtonByLabel(translate("dataCompare.compare"));
    expect(compareButton.disabled).toBe(false);
    compareButton.click();
    await flushAsyncSetup();

    expect(mocks.prepareDataCompareFromTables).toHaveBeenCalledTimes(2);
    const payloads = mocks.prepareDataCompareFromTables.mock.calls.map((call) => call[0]);
    expect(payloads.map((payload) => payload.sourceTable)).toEqual(["ALPHA", "BETA"]);
    // Global setting: every per-table request carries the identical parsed list.
    for (const payload of payloads) {
      expect(payload.ignoredColumns).toEqual(PARSED_IGNORED_COLUMNS);
    }
    expect(mocks.prepareDataCompareMissingTarget).not.toHaveBeenCalled();
  });

  it("compares every table when an ignored column only exists on some of them", async () => {
    // G-1 scenario: ALPHA exposes created_at + updated_at while BETA only has
    // created_at; both keep the ID primary key so per-table key inference succeeds.
    mocks.state.tableColumns = {
      ALPHA: [
        { name: "ID", data_type: "NUMBER", is_primary_key: true },
        { name: "CREATED_AT", data_type: "TIMESTAMP", is_primary_key: false },
        { name: "UPDATED_AT", data_type: "TIMESTAMP", is_primary_key: false },
      ],
      BETA: [
        { name: "ID", data_type: "NUMBER", is_primary_key: true },
        { name: "CREATED_AT", data_type: "TIMESTAMP", is_primary_key: false },
      ],
    };
    const app = await mountOpenDialog();
    const setupState = dialogSetupState(app);
    setupState.sourceConnectionId = SOURCE_CONNECTION_ID;
    await flushAsyncSetup();
    setupState.targetConnectionId = TARGET_CONNECTION_ID;
    await flushAsyncSetup();
    setupState.sourceTableSelection = ["ALPHA", "BETA"];
    await flushAsyncSetup();

    await typeIgnoredColumns(app);

    const compareButton = findButtonByLabel(translate("dataCompare.compare"));
    expect(compareButton.disabled).toBe(false);
    compareButton.click();
    await flushAsyncSetup();

    // BETA must not fail just because it lacks the updated_at ignored column.
    expect(mocks.prepareDataCompareFromTables).toHaveBeenCalledTimes(2);
    const payloads = mocks.prepareDataCompareFromTables.mock.calls.map((call) => call[0]);
    expect(payloads.map((payload) => payload.sourceTable)).toEqual(["ALPHA", "BETA"]);
    // Global setting: every per-table request still carries the identical parsed list.
    for (const payload of payloads) {
      expect(payload.ignoredColumns).toEqual(PARSED_IGNORED_COLUMNS);
    }
    // Each table filters to its own common columns: ALPHA keeps updated_at,
    // BETA never had it. (The frontend intersection already drops it for BETA;
    // filtering ignored columns out of the remaining columns is core-side.)
    const alphaPayload = payloads[0];
    const betaPayload = payloads[1];
    expect(alphaPayload.columns).toEqual(["ID", "CREATED_AT", "UPDATED_AT"]);
    expect(betaPayload.columns).toEqual(["ID", "CREATED_AT"]);
    expect(mocks.prepareDataCompareMissingTarget).not.toHaveBeenCalled();
  });

  it("omits ignoredColumns from the missing-target preparation payload", async () => {
    mocks.state.targetTables = ["ALPHA"];
    const app = await mountOpenDialog();
    const setupState = dialogSetupState(app);
    setupState.sourceConnectionId = SOURCE_CONNECTION_ID;
    await flushAsyncSetup();
    setupState.targetConnectionId = TARGET_CONNECTION_ID;
    await flushAsyncSetup();
    setupState.sourceTableSelection = ["ALPHA", "BETA"];
    await flushAsyncSetup();

    await typeIgnoredColumns(app);

    const compareButton = findButtonByLabel(translate("dataCompare.compare"));
    expect(compareButton.disabled).toBe(false);
    compareButton.click();
    await flushAsyncSetup();

    expect(mocks.prepareDataCompareFromTables).toHaveBeenCalledTimes(1);
    expect(mocks.prepareDataCompareFromTables.mock.calls[0][0].sourceTable).toBe("ALPHA");
    expect(mocks.prepareDataCompareFromTables.mock.calls[0][0].ignoredColumns).toEqual(PARSED_IGNORED_COLUMNS);

    expect(mocks.prepareDataCompareMissingTarget).toHaveBeenCalledTimes(1);
    const missingPayload = mocks.prepareDataCompareMissingTarget.mock.calls[0][0];
    expect(missingPayload.sourceTable).toBe("BETA");
    expect(Object.prototype.hasOwnProperty.call(missingPayload, "ignoredColumns")).toBe(false);
  });
});
