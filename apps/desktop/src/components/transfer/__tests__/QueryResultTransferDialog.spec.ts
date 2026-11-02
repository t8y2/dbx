// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, shallowRef, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, DatabaseType, QueryResult } from "@/types/database";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const api = vi.hoisted(() => ({
  executeInTransaction: vi.fn(),
  executeQuery: vi.fn(),
  executeMulti: vi.fn(),
  listTables: vi.fn(),
  listDatabases: vi.fn(),
  getTableDisplayDdl: vi.fn(),
  getColumns: vi.fn(),
}));
const storeMocks = vi.hoisted(() => ({
  connections: [] as ConnectionConfig[],
  connectionStore: null as {
    connections: ConnectionConfig[];
    sidebarLayout: { groups: unknown[]; order: unknown[] };
    ensureConnected: (id: string) => Promise<void>;
    getConfig: (id: string) => ConnectionConfig | undefined;
    connectionIdentifierQuote: (id: string) => string | undefined;
  } | null,
  settingsStore: { editorSettings: { exportRowLimitEnabled: false, exportRowLimit: 1000 } },
  productionSafetyStore: { requestConfirmation: vi.fn() },
  toast: vi.fn(),
  ensureReadOnlyWriteAccess: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => api);
vi.mock("@/lib/database/readOnlyWriteAccess", () => ({ ensureReadOnlyWriteAccess: storeMocks.ensureReadOnlyWriteAccess }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: storeMocks.toast }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => storeMocks.settingsStore }));
vi.mock("@/stores/productionSafetyStore", () => ({ useProductionSafetyStore: () => storeMocks.productionSafetyStore }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => storeMocks.connectionStore }));
vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    inheritAttrs: false,
    props: { open: { type: Boolean, default: undefined } },
    setup(_props, { attrs, slots }) {
      return () => h("div", attrs, slots.default?.());
    },
  });
  const content = defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => h("div", { ...attrs, "data-slot": "dialog-content" }, slots.default?.());
    },
  });
  return { Dialog: passthrough, DialogContent: content, DialogDescription: passthrough, DialogFooter: passthrough, DialogHeader: passthrough, DialogTitle: passthrough };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      inheritAttrs: false,
      props: { disabled: Boolean },
      emits: ["click"],
      setup(props, { attrs, emit, slots }) {
        return () => h("button", { ...attrs, disabled: props.disabled, onClick: (event: Event) => emit("click", event) }, slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Input: defineComponent({
      inheritAttrs: false,
      props: { modelValue: { type: String, default: "" }, disabled: Boolean },
      emits: ["update:modelValue"],
      setup(props, { attrs, emit }) {
        return () =>
          h("input", {
            ...attrs,
            disabled: props.disabled,
            value: props.modelValue,
            onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
          });
      },
    }),
  };
});

vi.mock("@/components/ui/searchable-select/SearchableSelect.vue", () => ({
  default: defineComponent({
    props: ["modelValue", "options", "loading", "disabled"],
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () => h("input", { value: props.modelValue, disabled: props.disabled, "data-databases": JSON.stringify(props.options), "data-loading": String(props.loading), onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value) });
    },
  }),
}));

vi.mock("@/components/ui/label", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Label: defineComponent({
      setup(_props, { slots }) {
        return () => h("label", slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/connection/ConnectionTreeSelect.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { modelValue: { type: String, default: "" }, connections: { type: Array, default: () => [] } },
      emits: ["update:modelValue"],
      setup(props, { emit }) {
        return () =>
          h(
            "select",
            {
              "data-testid": "target-connection",
              value: props.modelValue,
              onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value),
            },
            (props.connections as ConnectionConfig[]).map((connection) => h("option", { value: connection.id }, connection.name)),
          );
      },
    }),
  };
});

vi.mock("@lucide/vue", async () => {
  const { defineComponent, h } = await import("vue");
  const icon = defineComponent({ setup: () => () => h("span") });
  return { ArrowRightLeft: icon, Loader2: icon };
});

import QueryResultTransferDialog from "../QueryResultTransferDialog.vue";

const mountedApps: App[] = [];
const result: QueryResult = {
  columns: ["id", "name"],
  column_types: ["INTEGER", "VARCHAR(32)"],
  rows: [
    [1, "Alice"],
    [2, "Bob"],
  ],
  affected_rows: 0,
  execution_time_ms: 1,
  sourceLabel: "items",
};

function config(id: string, dbType: DatabaseType): ConnectionConfig {
  return { id, name: `${dbType} target`, db_type: dbType, host: "localhost", port: 1234, username: "user", password: "secret", database: "target", default_schema: "app" };
}

function configureStore(target: ConnectionConfig): void {
  storeMocks.connections = [target];
  storeMocks.connectionStore = {
    connections: storeMocks.connections,
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    sidebarLayout: { groups: [], order: [] },
    getConfig: (id) => storeMocks.connections.find((connection) => connection.id === id),
    connectionIdentifierQuote: () => undefined,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mountDialog(target: ConnectionConfig, overrides: Partial<Record<string, unknown>> = {}) {
  configureStore(target);
  const model = ref(false);
  const dynamicProps = shallowRef(overrides);
  const loadResult = vi.fn().mockResolvedValue(result);
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(QueryResultTransferDialog, {
            open: model.value,
            "onUpdate:open": (value: boolean) => {
              model.value = value;
            },
            sourceConnectionId: "source",
            sourceDatabase: "source_db",
            sourceDatabaseType: "mysql",
            result,
            loadResult,
            ...dynamicProps.value,
          });
      },
    }),
  );
  mountedApps.push(app);
  app.mount(container);
  model.value = true;
  await settle();
  const connection = container.querySelector<HTMLSelectElement>("[data-testid='target-connection']")!;
  connection.value = target.id;
  connection.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  return {
    app,
    container,
    model,
    loadResult,
    setProps: (values: Record<string, unknown>) => {
      dynamicProps.value = { ...dynamicProps.value, ...values };
    },
  };
}

function input(container: HTMLElement, type: string, index = 0): HTMLInputElement {
  return [...container.querySelectorAll<HTMLInputElement>(`input[type='${type}']`)][index]!;
}

function startButton(container: HTMLElement): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("transfer.start"))!;
}

async function startTransfer(container: HTMLElement): Promise<void> {
  startButton(container).click();
  await settle();
  container.querySelector<HTMLButtonElement>('[data-testid="transfer-confirm"]')!.click();
  await settle();
}

function textInput(container: HTMLElement, index: number): HTMLInputElement {
  return [...container.querySelectorAll<HTMLInputElement>("input:not([type])")][index]!;
}

function setInput(element: HTMLInputElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("QueryResultTransferDialog execution boundaries", () => {
  beforeEach(() => {
    api.executeInTransaction.mockReset().mockResolvedValue(undefined);
    api.executeQuery.mockReset().mockResolvedValue({ columns: [], rows: [] });
    api.executeMulti.mockReset();
    api.listDatabases.mockReset().mockResolvedValue([{ name: "target_db" }]);
    api.listTables.mockReset().mockResolvedValue([]);
    api.getTableDisplayDdl.mockReset().mockResolvedValue('CREATE TABLE "items" ("id" INTEGER, "name" VARCHAR(32)) ENGINE=InnoDB');
    api.getColumns.mockReset().mockResolvedValue([
      { name: "id", data_type: "INTEGER" },
      { name: "name", data_type: "VARCHAR(32)" },
    ]);
    storeMocks.ensureReadOnlyWriteAccess.mockReset().mockResolvedValue(true);
    storeMocks.productionSafetyStore.requestConfirmation.mockReset().mockResolvedValue(true);
    storeMocks.toast.mockReset();
    storeMocks.settingsStore.editorSettings = { exportRowLimitEnabled: false, exportRowLimit: 1000 };
  });

  afterEach(() => {
    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.textContent = "";
  });

  it.each(["postgres", "sqlite", "sqlserver"] as DatabaseType[])("keeps %s overwrite/create in one transaction", async (dbType) => {
    const { container } = await mountDialog(config("target", dbType));
    input(container, "radio", 1).click();
    await settle();
    await startTransfer(container);

    expect(api.executeInTransaction).toHaveBeenCalledTimes(1);
    const statements = api.executeInTransaction.mock.calls[0][2] as string[];
    expect(statements.some((statement) => /^CREATE TABLE /i.test(statement))).toBe(true);
    expect(statements.some((statement) => /^INSERT INTO /i.test(statement))).toBe(true);
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("loads searchable database options for the selected connection", async () => {
    api.listDatabases.mockResolvedValue([{ name: "app" }, { name: "archive" }]);
    const { container } = await mountDialog({ id: "target", name: "MySQL", db_type: "mysql", database: "app" } as ConnectionConfig);
    expect(api.listDatabases).toHaveBeenCalledWith("target");
    expect(textInput(container, 0).getAttribute("data-databases")).toBe('["app","archive"]');
    expect(textInput(container, 0).value).toBe("app");
  });

  it("ignores a database response from a closed dialog", async () => {
    let resolveOld!: (value: { name: string }[]) => void;
    api.listDatabases.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    const { container, model } = await mountDialog({ id: "target", name: "MySQL", db_type: "mysql", database: "app" } as ConnectionConfig);
    model.value = false;
    await settle();
    model.value = true;
    await settle();
    api.listDatabases.mockResolvedValueOnce([{ name: "new_database" }]);
    const connection = container.querySelector<HTMLSelectElement>("[data-testid='target-connection']")!;
    connection.value = "target";
    connection.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    resolveOld([{ name: "stale_database" }]);
    await settle();
    expect(textInput(container, 0).getAttribute("data-databases")).toBe('["new_database"]');
  });

  it("previews the destination and operations without reading or writing data", async () => {
    const { container, loadResult } = await mountDialog(config("target", "mysql"));
    container.querySelector<HTMLButtonElement>('[data-testid="transfer-preview"]')!.click();
    await settle();
    const overview = container.querySelector('[data-testid="transfer-overview"]')!;
    expect(overview.textContent).toContain("mysql target / target / items");
    expect(overview.textContent).toContain("exportDatabasePlanCreate");
    expect(overview.textContent).toContain('"rows":2,"columns":2');
    expect(overview.textContent).toContain("id, name");
    expect(loadResult).not.toHaveBeenCalled();
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(api.executeInTransaction).not.toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>('[data-testid="transfer-review-back"]')!.click();
    await settle();
    expect(container.querySelector('[data-testid="transfer-overview"]')).toBeNull();
    expect(textInput(container, 2).value).toBe("items");
  });

  it("requires a separate confirmation after Start, and cancellation performs no transfer", async () => {
    const { container, loadResult } = await mountDialog(config("target", "mysql"));
    startButton(container).click();
    await settle();
    expect(container.querySelector('[data-testid="transfer-confirm"]')).not.toBeNull();
    expect(loadResult).not.toHaveBeenCalled();
    expect(storeMocks.ensureReadOnlyWriteAccess).not.toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>('[data-testid="transfer-review-back"]')!.click();
    await settle();
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(api.executeInTransaction).not.toHaveBeenCalled();
    await startTransfer(container);
    expect(api.executeInTransaction).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation from preview and warns that overwrite deletes all existing rows", async () => {
    const { container, loadResult } = await mountDialog(config("target", "mysql"));
    input(container, "checkbox").click();
    input(container, "radio", 1).click();
    await settle();
    container.querySelector<HTMLButtonElement>('[data-testid="transfer-preview"]')!.click();
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("exportDatabaseOverwriteWarning");
    expect(container.querySelector('[data-testid="transfer-overview"]')?.textContent).toContain("exportDatabasePlanOverwrite");
    container.querySelector<HTMLButtonElement>('[data-testid="transfer-preview-start"]')!.click();
    await settle();
    expect(loadResult).not.toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>('[data-testid="transfer-confirm"]')!.click();
    await settle();
    expect(api.executeInTransaction.mock.calls[0][2][0]).toMatch(/^DELETE FROM/);
  });

  it.each(["target", "source", "close"])("invalidates confirmation when %s changes", async (change) => {
    const { container, setProps, model, loadResult } = await mountDialog(config("target", "mysql"));
    startButton(container).click();
    await settle();
    const confirm = container.querySelector<HTMLButtonElement>('[data-testid="transfer-confirm"]')!;
    if (change === "target") setInput(textInput(container, 2), "different_table");
    else if (change === "source") setProps({ result: { ...result, rows: [[3, "Other"]] } });
    else model.value = false;
    await settle();
    expect(container.querySelector('[data-testid="transfer-confirm"]')).toBeNull();
    confirm.click();
    await settle();
    expect(loadResult).not.toHaveBeenCalled();
    expect(api.executeInTransaction).not.toHaveBeenCalled();
  });

  it("moves the dialog using the title and resets its position when reopened", async () => {
    const { container, model } = await mountDialog({ id: "target", name: "MySQL", db_type: "mysql", database: "app" } as ConnectionConfig);
    expect(container.querySelector('[modal="false"]')).not.toBeNull();
    const handle = container.querySelector<HTMLElement>(".cursor-move")!;
    const content = handle.parentElement!.parentElement!;
    content.setAttribute("data-slot", "dialog-content");
    vi.spyOn(content, "getBoundingClientRect").mockReturnValue({ left: 100, top: 100, right: 500, bottom: 500 } as DOMRect);
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(false);
    handle.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 150, clientY: 150, pointerId: 1 }));
    handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 180, clientY: 170, pointerId: 1 }));
    await new Promise(requestAnimationFrame);
    expect(content.style.transform).toBe("translate3d(30px, 20px, 0)");
    handle.dispatchEvent(new Event("lostpointercapture"));
    model.value = false;
    await settle();
    model.value = true;
    await settle();
    expect(content.style.transform).toBe("translate3d(0px, 0px, 0)");
  });

  it("coalesces pointer moves and flushes the last position on release without rerendering the form", async () => {
    const { container } = await mountDialog(config("target", "mysql"));
    const handle = container.querySelector<HTMLElement>(".cursor-move")!;
    const content = container.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    const bounds = vi.spyOn(content, "getBoundingClientRect").mockReturnValue({ left: 100, top: 100, right: 500, bottom: 500 } as DOMRect);
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(false);
    const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 42);
    const cancelled = vi.spyOn(window, "cancelAnimationFrame");
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(content, { childList: true, subtree: true });
    try {
      handle.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 150, clientY: 150, pointerId: 1 }));
      for (let x = 151; x <= 180; x++) {
        handle.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: 170, pointerId: 1 }));
      }
      await nextTick();
      expect(frame).toHaveBeenCalledTimes(1);
      expect(bounds).toHaveBeenCalledTimes(1);
      expect(content.style.transform).toBe("translate3d(0px, 0px, 0)");
      handle.dispatchEvent(new PointerEvent("pointerup", { clientX: 190, clientY: 180, pointerId: 1 }));
      expect(content.style.transform).toBe("translate3d(40px, 30px, 0)");
      expect(cancelled).toHaveBeenCalledWith(42);
      handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 900, clientY: 900, pointerId: 1 }));
      await nextTick();
      expect(content.style.transform).toBe("translate3d(40px, 30px, 0)");
      expect(mutations).toHaveLength(0);
    } finally {
      observer.disconnect();
      frame.mockRestore();
      cancelled.mockRestore();
    }
  });

  it.each([false, true])("keeps the header visible after resize (active drag=%s)", async (activeDrag) => {
    const { container } = await mountDialog(config("target", "mysql"));
    const handle = container.querySelector<HTMLElement>(".cursor-move")!;
    const content = container.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    const rect = vi.spyOn(content, "getBoundingClientRect").mockReturnValue({ left: 100, top: 100, right: 500, bottom: 500 } as DOMRect);
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);
    handle.releasePointerCapture = vi.fn();
    handle.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 150, clientY: 150, pointerId: 1 }));
    handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 180, clientY: 170, pointerId: 1 }));
    await nextTick();
    if (!activeDrag) handle.dispatchEvent(new Event("lostpointercapture"));
    // The centered layout moved the previously dragged header outside the viewport.
    rect.mockReturnValue({ left: -100, top: -150, right: 500, bottom: 400 } as DOMRect);
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    await nextTick();
    expect(content.style.transform).toBe("translate3d(138px, 178px, 0)");
    handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 900, clientY: 900, pointerId: 1 }));
    await nextTick();
    expect(content.style.transform).toBe("translate3d(138px, 178px, 0)");
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("repositions when the dialog content itself changes size", async () => {
    const originalObserver = globalThis.ResizeObserver;
    const observers: Array<{ callback: ResizeObserverCallback; target?: Element }> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        target?: Element;
        constructor(public callback: ResizeObserverCallback) {
          observers.push(this);
        }
        observe(target: Element) {
          this.target = target;
        }
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      const { container } = await mountDialog(config("target", "mysql"));
      const content = container.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
      vi.spyOn(content, "getBoundingClientRect").mockReturnValue({ left: 100, top: -50, right: 500, bottom: 500 } as DOMRect);
      const observer = observers.find((item) => item.target === content)!;
      expect(observer).toBeDefined();
      observer.callback([], observer as unknown as ResizeObserver);
      await nextTick();
      await nextTick();
      expect(content.style.transform).toBe("translate3d(0px, 58px, 0)");
    } finally {
      vi.stubGlobal("ResizeObserver", originalObserver);
    }
  });

  it("preserves the original native transaction error without an out-of-transaction drop", async () => {
    api.executeInTransaction.mockRejectedValueOnce(new Error("insert failed"));
    const { container } = await mountDialog(config("target", "postgres"));
    input(container, "radio", 1).click();
    await settle();
    await startTransfer(container);

    expect(api.executeInTransaction).toHaveBeenCalledTimes(1);
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(storeMocks.toast).toHaveBeenCalledWith("insert failed", 6000);
  });

  it("stops before loading the result when the write guard denies the transfer", async () => {
    storeMocks.ensureReadOnlyWriteAccess.mockResolvedValueOnce(false);
    const { container, loadResult } = await mountDialog(config("target", "postgres"));
    await startTransfer(container);

    expect(storeMocks.ensureReadOnlyWriteAccess).toHaveBeenCalledTimes(1);
    expect(loadResult).not.toHaveBeenCalled();
    expect(api.listTables).not.toHaveBeenCalled();
    expect(api.executeInTransaction).not.toHaveBeenCalled();
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it.each(["mysql", "postgres", "sqlite", "sqlserver", "oracle", "oceanbase-oracle", "dameng", "yashandb", "h2", "db2"] as DatabaseType[])("rejects create for an existing %s target before any mutation", async (dbType) => {
    api.listTables.mockResolvedValueOnce([{ name: "items" }]);
    const { container } = await mountDialog(config("target", dbType));
    const create = input(container, "checkbox");
    expect(create.checked).toBe(true);
    expect(create.disabled).toBe(false);
    input(container, "radio", 1).click();
    await settle();
    await startTransfer(container);

    expect(api.listTables).toHaveBeenCalled();
    expect(api.executeInTransaction).not.toHaveBeenCalled();
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(storeMocks.toast).toHaveBeenCalledWith(expect.stringContaining("grid.exportDatabaseTargetExists"), 6000);
  });

  it.each(["mysql", "oracle", "h2"] as DatabaseType[])("cleans up a newly created %s table after a failed write", async (dbType) => {
    api.executeInTransaction.mockRejectedValueOnce(new Error("insert failed"));
    const { container } = await mountDialog(config("target", dbType));
    await startTransfer(container);

    expect(api.executeQuery).toHaveBeenCalledTimes(2);
    expect(api.executeQuery.mock.calls[0][2]).toMatch(/^CREATE TABLE /);
    expect(api.executeQuery.mock.calls[1][2]).toContain("DROP TABLE");
    expect(api.executeQuery.mock.invocationCallOrder[0]).toBeLessThan(api.executeInTransaction.mock.invocationCallOrder[0]);
    expect(api.executeInTransaction.mock.invocationCallOrder[0]).toBeLessThan(api.executeQuery.mock.invocationCallOrder[1]);
    expect(storeMocks.toast).toHaveBeenCalledWith("insert failed", 6000);
  });

  it.each(["mysql", "oracle", "h2"] as DatabaseType[])("never deletes a %s target when CREATE itself fails", async (dbType) => {
    api.executeQuery.mockRejectedValueOnce(new Error("table already exists"));
    const { container } = await mountDialog(config("target", dbType));
    await startTransfer(container);

    expect(api.executeQuery).toHaveBeenCalledTimes(1);
    expect(api.executeQuery.mock.calls[0][2]).toMatch(/^CREATE TABLE /);
    expect(api.executeInTransaction).not.toHaveBeenCalled();
    expect(storeMocks.toast).toHaveBeenCalledWith("table already exists", 6000);
  });

  it("uses GoldenDB identifier quoting without a cached driver quote across create, insert and cleanup", async () => {
    api.executeInTransaction.mockRejectedValueOnce(new Error("insert failed"));
    const { container } = await mountDialog(config("target", "goldendb"));
    expect(storeMocks.connectionStore!.connectionIdentifierQuote("target")).toBeUndefined();
    await startTransfer(container);

    expect(api.executeQuery).toHaveBeenCalledTimes(2);
    const create = api.executeQuery.mock.calls[0][2] as string;
    const insert = api.executeInTransaction.mock.calls[0][2][0] as string;
    const cleanup = api.executeQuery.mock.calls[1][2] as string;
    expect(create).toMatch(/^CREATE TABLE .*`items` \(`id` /);
    expect(insert).toMatch(/^INSERT INTO .*`items` \(`id`, `name`\) VALUES /);
    expect(cleanup).toMatch(/^DROP TABLE IF EXISTS .*`items`$/);
    expect(storeMocks.toast).toHaveBeenCalledWith("insert failed", 6000);
  });

  it.each(["create", "append", "overwrite"] as const)("writes only the selected SQLite attached database in %s mode", async (mode) => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`ATTACH ':memory:' AS aux;
        CREATE TABLE main.items (id INTEGER, name TEXT);
        INSERT INTO main.items VALUES (8, 'main sentinel');
        CREATE TABLE main.source (id INTEGER, name TEXT);
        CREATE UNIQUE INDEX main.source_name ON source (lower(name)) WHERE name IS NOT NULL;`);
      if (mode !== "create") db.exec("CREATE TABLE aux.items (id INTEGER, name TEXT); INSERT INTO aux.items VALUES (9, 'aux sentinel');");
      api.listTables.mockImplementation(async (_connectionId, _database, schema) => db.prepare(`SELECT name FROM "${schema}".sqlite_master WHERE type = 'table'`).all());
      api.getTableDisplayDdl.mockResolvedValueOnce('CREATE TABLE "items" ("id" INTEGER, "name" TEXT)');
      api.getColumns.mockResolvedValueOnce([
        { name: "id", data_type: "INTEGER" },
        { name: "name", data_type: "TEXT" },
      ]);
      api.executeInTransaction.mockImplementationOnce(async (_connectionId, _database, statements: string[]) => {
        db.exec("BEGIN");
        try {
          for (const statement of statements) db.exec(statement);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
      const sourceDdl = db
        .prepare("SELECT sql FROM main.sqlite_master WHERE tbl_name = 'source' AND sql IS NOT NULL ORDER BY type DESC")
        .all()
        .map((row) => row.sql)
        .join(";\n");
      const { container } = await mountDialog({ ...config("target", "sqlite"), host: ":memory:", database: "aux" }, { sourceDatabaseType: "sqlite", sourceTable: "source", sourceSql: "SELECT * FROM source", loadSourceDdl: vi.fn().mockResolvedValue(sourceDdl) });
      if (mode !== "create") input(container, "checkbox").click();
      if (mode === "overwrite") input(container, "radio", 1).click();
      await settle();
      await startTransfer(container);

      expect(storeMocks.toast).toHaveBeenCalledWith("grid.exportDatabaseDone");
      expect(db.prepare("SELECT * FROM main.items").all()).toEqual([{ id: 8, name: "main sentinel" }]);
      expect(db.prepare("SELECT * FROM aux.items ORDER BY id").all()).toEqual([{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }, ...(mode === "append" ? [{ id: 9, name: "aux sentinel" }] : [])]);
      if (mode === "create") {
        expect(api.listTables).toHaveBeenCalledWith("target", "aux", "aux");
        expect(db.prepare("SELECT sql FROM aux.sqlite_master WHERE type = 'index' AND tbl_name = 'items'").all()).toHaveLength(1);
        expect(() => db.exec("INSERT INTO aux.items VALUES (3, 'ALICE')")).toThrow(/UNIQUE/);
        expect(db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'index' AND tbl_name = 'items'").all()).toEqual([]);
      } else {
        expect(api.getTableDisplayDdl).toHaveBeenCalledWith("target", "aux", "aux", "items");
      }
    } finally {
      db.close();
    }
  });

  it.each(["/tmp/target.sqlite", "target.sqlite"])("normalizes a SQLite file target %s to main", async (host) => {
    const { container } = await mountDialog({ ...config("target", "sqlite"), host, database: host });
    await startTransfer(container);
    expect(api.listTables).toHaveBeenCalledWith("target", host, "main");
    expect(api.executeInTransaction.mock.calls[0][2][0]).toMatch(/^CREATE TABLE "main"\."items" /);
  });

  it("sends generic JDBC Oracle cleanup as one complete PL/SQL statement", async () => {
    api.executeInTransaction.mockRejectedValueOnce(new Error("insert failed"));
    const target = { ...config("target", "jdbc"), connection_string: "jdbc:oracle:thin:@localhost:1521/XEPDB1" };
    const { container } = await mountDialog(target);
    await startTransfer(container);

    expect(api.executeMulti).not.toHaveBeenCalled();
    expect(api.executeQuery).toHaveBeenCalledTimes(2);
    expect(api.executeQuery.mock.calls[1]).toEqual(["target", "target", `BEGIN EXECUTE IMMEDIATE 'DROP TABLE "app"."items" CASCADE CONSTRAINTS'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;`, "app", undefined, { executionMode: "simple" }]);
    expect(storeMocks.toast).toHaveBeenCalledWith("insert failed", 6000);
  });

  it("surfaces a single-statement cleanup failure together with the original write failure", async () => {
    api.executeInTransaction.mockRejectedValueOnce(new Error("insert failed"));
    api.executeQuery.mockResolvedValueOnce({ columns: [], rows: [] }).mockRejectedValueOnce(new Error("cleanup denied"));
    const { container } = await mountDialog({ ...config("target", "jdbc"), connection_string: "jdbc:oracle:thin:@localhost:1521/XEPDB1" });
    await startTransfer(container);

    expect(storeMocks.toast).toHaveBeenCalledWith(expect.stringContaining('"message":"insert failed","error":"cleanup denied"'), 8000);
    expect(storeMocks.toast).not.toHaveBeenCalledWith("grid.exportDatabaseDone");
  });

  it("does not claim ownership when a single-statement CREATE returns an execution error", async () => {
    api.executeQuery.mockResolvedValueOnce({ columns: [], rows: [], execution_error: true });
    const { container } = await mountDialog(config("target", "mysql"));
    await startTransfer(container);

    expect(api.executeQuery).toHaveBeenCalledTimes(1);
    expect(api.executeInTransaction).not.toHaveBeenCalled();
    expect(storeMocks.toast).toHaveBeenCalledWith("grid.exportDatabaseExecutionFailed", 6000);
  });

  it("allows overwrite/create for an empty H2 target after the preflight", async () => {
    api.listTables.mockResolvedValueOnce([]);
    const { container } = await mountDialog(config("target", "h2"));
    const create = input(container, "checkbox");
    expect(create.checked).toBe(true);
    expect(create.disabled).toBe(false);
    input(container, "radio", 1).click();
    await settle();
    await startTransfer(container);

    const statements = api.executeInTransaction.mock.calls[0][2] as string[];
    expect(api.listTables).toHaveBeenCalled();
    expect(api.executeQuery.mock.calls[0][2]).toMatch(/^CREATE TABLE /);
    expect(statements.some((statement) => /^CREATE TABLE /i.test(statement))).toBe(false);
    expect(statements.some((statement) => /^INSERT INTO /i.test(statement))).toBe(true);
  });

  it("writes only to an existing Oracle table when creation is unchecked", async () => {
    const { container } = await mountDialog(config("target", "oracle"));
    input(container, "checkbox").click();
    await settle();
    await startTransfer(container);

    const statements = api.executeInTransaction.mock.calls[0][2] as string[];
    expect(api.listTables).not.toHaveBeenCalled();
    expect(api.getTableDisplayDdl).toHaveBeenCalledWith("target", "target", "app", "items");
    expect(statements.some((statement) => /^CREATE TABLE |^DROP TABLE /i.test(statement))).toBe(false);
    expect(statements[0]).toMatch(/^INSERT ALL\n/);
    expect(statements[0]).toContain("SELECT 1 FROM dual");
  });

  it("uses delete plus insert for an existing H2 table when creation is unchecked", async () => {
    const { container } = await mountDialog(config("target", "h2"));
    input(container, "checkbox").click();
    input(container, "radio", 1).click();
    await settle();
    await startTransfer(container);

    const statements = api.executeInTransaction.mock.calls[0][2] as string[];
    expect(api.listTables).not.toHaveBeenCalled();
    expect(statements[0]).toMatch(/^DELETE FROM /i);
    expect(statements.some((statement) => /^CREATE TABLE |^DROP TABLE /i.test(statement))).toBe(false);
    expect(statements.some((statement) => /^INSERT INTO /i.test(statement))).toBe(true);
  });

  it("keeps an existing MySQL target untouched when creation was requested", async () => {
    api.listTables.mockResolvedValueOnce([{ name: "items" }]);
    const { container } = await mountDialog(config("target", "mysql"));
    input(container, "radio", 1).click();
    await settle();
    await startTransfer(container);

    expect(api.executeInTransaction).not.toHaveBeenCalled();
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("reuses the source MySQL DDL when the result is a direct table projection", async () => {
    api.executeQuery.mockResolvedValueOnce({ columns: ["Collation"], rows: [["utf8mb4_0900_ai_ci"]] });
    const sourceDdl = "CREATE TABLE `apis` (`id` bigint unsigned NOT NULL AUTO_INCREMENT, `method` varchar(20) DEFAULT NULL, PRIMARY KEY (`id`), KEY `idx_apis_method` (`method`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;";
    const loadSourceDdl = vi.fn().mockResolvedValue(sourceDdl);
    const sourceResult = {
      ...result,
      columns: ["id", "method"],
      rows: [
        [1, "GET"],
        [2, "POST"],
      ],
    };
    const { container } = await mountDialog(config("target", "mysql"), { sourceTable: "apis", sourceSql: "SELECT * FROM apis", result: sourceResult, loadResult: vi.fn().mockResolvedValue(sourceResult), loadSourceDdl });
    await startTransfer(container);

    const createStatement = api.executeQuery.mock.calls.find((call) => /^CREATE TABLE /i.test(call[2]))![2];
    expect(loadSourceDdl).toHaveBeenCalledTimes(1);
    expect(createStatement).toContain("bigint unsigned NOT NULL AUTO_INCREMENT");
    expect(createStatement).toContain("varchar(20) DEFAULT NULL");
    expect(createStatement).toContain("KEY `idx_apis_method` (`method`)");
    expect(createStatement).toContain("COLLATE=utf8mb4_0900_ai_ci");
  });

  it.each(["utf8mb4_unicode_520_ci", "utf8mb4_unicode_ci"])("adapts MySQL 8 DDL to target collation %s before creating the table", async (collation) => {
    api.executeQuery.mockResolvedValueOnce({ columns: ["Collation", "Charset"], rows: [[collation, "utf8mb4"]] });
    const ddl = "CREATE TABLE items (id INT, name VARCHAR(32) COLLATE utf8mb4_0900_ai_ci) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci";
    const { container } = await mountDialog(config("target", "mysql"), { sourceTable: "items", sourceSql: "SELECT * FROM items", loadSourceDdl: vi.fn().mockResolvedValue(ddl) });
    await startTransfer(container);
    expect(api.executeQuery.mock.calls[0].slice(0, 3)).toEqual(["target", "target", "SHOW COLLATION"]);
    const create = api.executeQuery.mock.calls[1][2] as string;
    expect(create).toContain(`COLLATE ${collation}`);
    expect(create).toContain(`COLLATE=${collation}`);
    expect(create).not.toContain("0900");
    expect(api.executeInTransaction).toHaveBeenCalledTimes(1);
    expect(storeMocks.toast.mock.calls.some(([message]) => message.includes("exportDatabaseCollationAdapted"))).toBe(true);
  });

  it("stops before CREATE when the target has no known compatible collation", async () => {
    api.executeQuery.mockResolvedValueOnce({ columns: ["Collation"], rows: [["latin1_swedish_ci"]] });
    const { container } = await mountDialog(config("target", "mysql"), { sourceTable: "items", sourceSql: "SELECT * FROM items", loadSourceDdl: vi.fn().mockResolvedValue("CREATE TABLE items (id INT, name TEXT) ENGINE=InnoDB COLLATE=utf8mb4_0900_ai_ci") });
    await startTransfer(container);
    expect(api.executeQuery).toHaveBeenCalledTimes(1);
    expect(api.executeInTransaction).not.toHaveBeenCalled();
    expect(storeMocks.toast).toHaveBeenCalledWith(expect.stringContaining("exportDatabaseUnsupportedCollation"), 6000);
  });

  it("exports ordinary column projections without requesting an unavailable source DDL", async () => {
    const loadSourceDdl = vi.fn().mockResolvedValue(undefined);
    const { container } = await mountDialog(config("target", "mysql"), { sourceTable: "items", sourceSql: "SELECT id, name FROM items", loadSourceDdl });
    await startTransfer(container);

    expect(loadSourceDdl).not.toHaveBeenCalled();
    expect(api.executeQuery.mock.calls[0][2]).toMatch(/^CREATE TABLE /);
    expect(api.executeInTransaction).toHaveBeenCalledTimes(1);
  });

  it("inspects the existing target DDL instead of the source when create is unchecked", async () => {
    const loadSourceDdl = vi.fn().mockResolvedValue(undefined);
    const { container } = await mountDialog(config("target", "mysql"), { sourceTable: "items", sourceSql: "SELECT * FROM items", loadSourceDdl });
    input(container, "checkbox").click();
    await settle();
    await startTransfer(container);

    expect(loadSourceDdl).not.toHaveBeenCalled();
    expect(api.getTableDisplayDdl).toHaveBeenCalled();
    expect(api.executeInTransaction).toHaveBeenCalledTimes(1);
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("resolves existing MySQL column casing before excluding generated columns", async () => {
    api.getTableDisplayDdl.mockResolvedValueOnce("CREATE TABLE items (id INTEGER, name VARCHAR(32), total INTEGER AS (id * 2) STORED) ENGINE=InnoDB");
    api.getColumns.mockResolvedValueOnce([
      { name: "id", data_type: "INTEGER" },
      { name: "name", data_type: "VARCHAR(32)" },
      { name: "total", data_type: "INTEGER" },
    ]);
    const sourceResult = { ...result, columns: ["ID", "NAME", "TOTAL"], rows: [[1, "Alice", 2]], column_types: ["INTEGER", "VARCHAR", "INTEGER"] };
    const { container } = await mountDialog(config("target", "mysql"), { loadResult: vi.fn().mockResolvedValue(sourceResult) });
    input(container, "checkbox").click();
    await settle();
    await startTransfer(container);
    const statements = api.executeInTransaction.mock.calls[0][2] as string[];
    expect(statements[0]).toContain("(`id`, `name`)");
    expect(statements[0]).not.toContain("total");
  });

  it.each(["TIMESTAMP(3)", "TIMESTAMP", "TIME"])("rejects fractional loss using an existing H2 %s declaration before overwriting", async (declaration) => {
    api.getTableDisplayDdl.mockResolvedValueOnce(`CREATE TABLE "items" ("created" ${declaration})`);
    // H2 getColumns only exposes DATA_TYPE, omitting DATETIME_PRECISION.
    api.getColumns.mockResolvedValueOnce([{ name: "created", data_type: declaration.startsWith("TIME(") || declaration === "TIME" ? "TIME" : "TIMESTAMP" }]);
    const sourceResult = { ...result, columns: ["created"], column_types: ["TIMESTAMP"], rows: [[declaration === "TIME" ? "12:34:56.123456789" : "2026-10-07 12:34:56.123456789"]] };
    const { container } = await mountDialog(config("target", "h2"), { loadResult: vi.fn().mockResolvedValue(sourceResult), sourceDatabaseType: "h2" });
    input(container, "checkbox").click();
    input(container, "radio", 1).click();
    await settle();
    await startTransfer(container);
    expect(api.executeInTransaction).not.toHaveBeenCalled();
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(storeMocks.toast).toHaveBeenCalledWith(expect.stringContaining("grid.exportDatabaseValueUnsupported"), 6000);
  });

  it("allows insignificant zeroes past an existing target's declared temporal precision", async () => {
    api.getTableDisplayDdl.mockResolvedValueOnce('CREATE TABLE "items" ("created" TIMESTAMP(3))');
    api.getColumns.mockResolvedValueOnce([{ name: "created", data_type: "TIMESTAMP" }]);
    const sourceResult = { ...result, columns: ["created"], column_types: ["TIMESTAMP"], rows: [["2026-10-07 12:34:56.123000000"]] };
    const { container } = await mountDialog(config("target", "h2"), { loadResult: vi.fn().mockResolvedValue(sourceResult), sourceDatabaseType: "h2" });
    input(container, "checkbox").click();
    await settle();
    await startTransfer(container);
    expect(api.executeInTransaction.mock.calls[0][2][0]).toContain("2026-10-07 12:34:56.123000000");
  });

  it("retains the declared precision when reusing a same-engine source DDL", async () => {
    const sourceResult = { ...result, columns: ["created"], column_types: ["TIMESTAMP"], rows: [["2026-10-07 12:34:56.123456789"]] };
    const loadSourceDdl = vi.fn().mockResolvedValue('CREATE TABLE "items" ("created" TIMESTAMP(9))');
    const { container } = await mountDialog(config("target", "h2"), { result: sourceResult, loadResult: vi.fn().mockResolvedValue(sourceResult), sourceDatabaseType: "h2", sourceSql: 'SELECT * FROM "items"', sourceTable: "items", loadSourceDdl });
    await startTransfer(container);
    expect(api.executeQuery.mock.calls[0][2]).toContain("TIMESTAMP(9)");
    expect(api.executeInTransaction.mock.calls[0][2][0]).toContain("2026-10-07 12:34:56.123456789");
  });

  it("rejects an unknown bare temporal declaration instead of assuming wire precision", async () => {
    api.getTableDisplayDdl.mockResolvedValueOnce('CREATE TABLE "items" ("created" TIMESTAMP)');
    api.getColumns.mockResolvedValueOnce([{ name: "created", data_type: "TIMESTAMP" }]);
    const sourceResult = { ...result, columns: ["created"], column_types: ["TIMESTAMP"], rows: [["2026-10-07 12:34:56.123456789"]] };
    const { container } = await mountDialog(config("target", "iris"), { loadResult: vi.fn().mockResolvedValue(sourceResult) });
    input(container, "checkbox").click();
    await settle();
    await startTransfer(container);
    expect(api.executeInTransaction).not.toHaveBeenCalled();
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(storeMocks.toast).toHaveBeenCalledWith(expect.stringContaining("grid.exportDatabaseValueUnsupported"), 6000);
  });

  it.each(["sqlserver", "jdbc"] as const)("keeps SQL Server identity batches intact for a %s target", async (dbType) => {
    api.getTableDisplayDdl.mockResolvedValueOnce("CREATE TABLE [items] ([Id] int IDENTITY(1,1), [name] nvarchar(32))");
    api.getColumns.mockResolvedValueOnce([
      { name: "Id", data_type: "int" },
      { name: "name", data_type: "nvarchar(32)" },
    ]);
    const { container } = await mountDialog({ ...config("target", dbType), connection_string: "jdbc:sqlserver://localhost:1433;databaseName=target" });
    input(container, "checkbox").click();
    await settle();
    await startTransfer(container);
    const statements = api.executeInTransaction.mock.calls[0][2] as string[];
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^BEGIN TRY[\s\S]+END CATCH$/);
    expect(statements[0]).toContain("SET IDENTITY_INSERT [app].[items] ON");
    expect(statements[0]).toContain("([Id], [name])");
    expect(api.executeMulti).not.toHaveBeenCalled();
  });

  it("uses individual inserts for the SQL Server 2000 profile", async () => {
    const { container } = await mountDialog({ ...config("target", "sqlserver"), driver_profile: "sqlserver-legacy" });
    await startTransfer(container);
    const statements = api.executeInTransaction.mock.calls[0][2] as string[];
    expect(statements.filter((sql) => sql.startsWith("INSERT INTO"))).toHaveLength(2);
    expect(statements.join("\n")).not.toContain("),\n(");
  });

  it("requires an explicit namespace for schema-aware targets instead of guessing from the database", async () => {
    const { container } = await mountDialog({ ...config("target", "postgres"), default_schema: undefined });
    expect(startButton(container).disabled).toBe(true);
    setInput(textInput(container, 1), "sales");
    await settle();
    await startTransfer(container);
    expect(api.listTables.mock.calls[0][2]).toBe("sales");
    expect(api.executeInTransaction.mock.calls[0][2][0]).toMatch(/^CREATE TABLE "sales"\."items"/);
  });

  it.each(["postgres", "jdbc"] as const)("preserves PostgreSQL identity DO blocks and exact column names for a %s target", async (dbType) => {
    const sourceResult = { ...result, columns: ["Id", "id", " name ", "computed"], rows: [[7, 9, "value", 14]], column_types: ["BIGINT", "INTEGER", "TEXT", "INTEGER"] };
    const loadSourceDdl = vi.fn().mockResolvedValue('CREATE TABLE "items" ("Id" bigint GENERATED ALWAYS AS IDENTITY, "id" integer, " name " text, "computed" integer GENERATED ALWAYS AS ("Id" * 2) STORED)');
    const { container } = await mountDialog(
      { ...config("target", dbType), connection_string: "jdbc:postgresql://localhost:5432/target" },
      { sourceDatabaseType: "postgres", sourceTable: "items", sourceSql: 'SELECT * FROM "items"', result: sourceResult, loadResult: vi.fn().mockResolvedValue(sourceResult), loadSourceDdl },
    );
    await startTransfer(container);
    const statements = api.executeInTransaction.mock.calls[0][2] as string[];
    const insert = statements.find((sql) => sql.startsWith("INSERT INTO"));
    expect(insert).toContain('("Id", "id", " name ") OVERRIDING SYSTEM VALUE');
    expect(insert).not.toContain("computed");
    expect(statements[statements.length - 1]).toContain("pg_get_serial_sequence");
    expect(statements[statements.length - 1]).toMatch(/^DO \$dbx_transfer\$[\s\S]+END;\n\$dbx_transfer\$$/);
    expect(api.executeMulti).not.toHaveBeenCalled();
  });

  it.each(["cancel", "close", "source change"])("stops a pending result load after %s without writing", async (action) => {
    const pending = deferred<QueryResult>();
    const { container, model, setProps } = await mountDialog(config("target", "postgres"), { loadResult: () => pending.promise });
    await startTransfer(container);
    await settle();
    if (action === "cancel") [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("transfer.cancel"))!.click();
    else if (action === "close") model.value = false;
    else setProps({ sourceSql: "SELECT * FROM different_table" });
    await settle();
    pending.resolve(result);
    await settle();

    expect(api.executeInTransaction).not.toHaveBeenCalled();
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(storeMocks.toast).toHaveBeenCalledWith("grid.exportDatabaseCancelled", 6000);
  });

  it("matches a marked production database case-insensitively and stops on denied confirmation", async () => {
    const target = { ...config("target", "mysql"), production_databases: ["TARGET"] };
    storeMocks.productionSafetyStore.requestConfirmation.mockResolvedValueOnce(false);
    const { container, loadResult } = await mountDialog(target);
    await startTransfer(container);

    expect(storeMocks.productionSafetyStore.requestConfirmation).toHaveBeenCalledWith(expect.objectContaining({ database: "target" }));
    expect(loadResult).not.toHaveBeenCalled();
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(api.executeInTransaction).not.toHaveBeenCalled();
  });

  it("ignores a MySQL schema field so it cannot redirect writes into another database", async () => {
    const { container } = await mountDialog(config("target", "mysql"));
    expect(textInput(container, 1).disabled).toBe(true);
    setInput(textInput(container, 1), "production");
    await settle();
    await startTransfer(container);

    expect(api.executeQuery.mock.calls[0][1]).toBe("target");
    expect(api.executeQuery.mock.calls[0][2]).toMatch(/^CREATE TABLE `items` /);
    expect(api.executeQuery.mock.calls[0][3]).toBeUndefined();
    expect(api.executeInTransaction.mock.calls[0][3]).toBeUndefined();
  });
});
