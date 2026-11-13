// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TableImportProgress, TableImportRequest, TableImportSummary } from "@/lib/backend/api";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listTables: vi.fn().mockResolvedValue([]),
  getColumns: vi.fn().mockResolvedValue([
    { name: "id", data_type: "INTEGER", nullable: false },
    { name: "name", data_type: "TEXT", nullable: true },
  ]),
  listDataTypes: vi.fn().mockResolvedValue(["INTEGER", "TEXT"]),
  previewTableImportFile: vi.fn(),
  importTableFile: vi.fn<(request: TableImportRequest, onProgress: (progress: TableImportProgress) => void) => Promise<TableImportSummary>>(),
  releaseTableImportSource: vi.fn().mockResolvedValue(undefined),
  releaseSqlFilePreview: vi.fn().mockResolvedValue(undefined),
  toast: vi.fn(),
  previewSqlFile: vi.fn(),
  nativeOpen: vi.fn(),
  tauriRuntime: false,
}));

const connectionStore = vi.hoisted(() => ({
  sqlFileSource: null as unknown,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: (id: string) => ({ id, name: id === "mysql-1" ? "MySQL" : "SQLite", db_type: id === "mysql-1" ? "mysql" : "sqlite" }),
    ensureConnected: mocks.ensureConnected,
    invalidateMetadataCache: vi.fn(),
    refreshObjectListTreeNode: vi.fn().mockResolvedValue(undefined),
    get sqlFileSource() {
      return connectionStore.sqlFileSource;
    },
    set sqlFileSource(value: unknown) {
      connectionStore.sqlFileSource = value;
    },
  }),
}));

vi.mock("@/lib/backend/http", () => ({
  previewSqlFile: mocks.previewSqlFile,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.nativeOpen }));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ editorSettings: {} }),
}));

vi.mock("@/lib/backend/api", () => ({
  listTables: mocks.listTables,
  getColumns: mocks.getColumns,
  listDataTypes: mocks.listDataTypes,
  previewTableImportFile: mocks.previewTableImportFile,
  releaseTableImportSource: mocks.releaseTableImportSource,
  releaseSqlFilePreview: mocks.releaseSqlFilePreview,
  importTableFile: mocks.importTableFile,
  cancelTableImport: vi.fn(),
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => mocks.tauriRuntime }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { attrs, slots }) {
      return () => h("div", attrs, slots.default?.());
    },
  });
  return {
    Dialog: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
    DialogFooter: passthrough,
    DialogScrollContent: passthrough,
  };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      props: { disabled: Boolean },
      emits: ["click"],
      setup(props, { attrs, slots, emit }) {
        return () => h("button", { ...attrs, disabled: props.disabled, onClick: () => emit("click") }, slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Input: defineComponent({
      props: { modelValue: [String, Number], disabled: Boolean },
      emits: ["update:modelValue"],
      setup(props, { attrs, emit }) {
        return () =>
          h("input", {
            ...attrs,
            value: props.modelValue,
            disabled: props.disabled,
            onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
          });
      },
    }),
  };
});

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

vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return {
    Select: passthrough,
    SelectContent: passthrough,
    SelectItem: passthrough,
    SelectTrigger: passthrough,
    SelectValue: passthrough,
  };
});

vi.mock("@/components/ui/searchable-select", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    SearchableSelect: defineComponent({
      props: { modelValue: { type: String, default: "" }, options: { type: Array<string>, default: () => [] }, disabled: Boolean },
      emits: ["update:modelValue"],
      setup(props, { emit }) {
        return () =>
          h(
            "select",
            {
              value: props.modelValue,
              disabled: props.disabled,
              onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
            },
            [(props.options as string[]).map((option) => h("option", { value: option }, option))],
          );
      },
    }),
  };
});

import TableImportDialog from "@/components/import/TableImportDialog.vue";

const mountedApps: App[] = [];

const MULTI_TABLE_ERROR = "SQL import supports one table per file; found 'orders' and 'users'";
const UNSUPPORTED_SQL_ERROR = "SQL import does not support ON DUPLICATE KEY / ON CONFLICT clauses";
// Keep the export structure from #14263, using synthetic tables and values.
const TABLEPLUS_STYLE_DUMP = `-- TablePlus 7.1.8(718)
/*!40101 SET NAMES utf8mb4 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
DROP TABLE IF EXISTS orders;
CREATE TABLE orders (id INT PRIMARY KEY, user_id INT, FOREIGN KEY (user_id) REFERENCES users(id));
DROP TABLE IF EXISTS users;
CREATE TABLE users (id INT PRIMARY KEY);
INSERT INTO orders (id, user_id) VALUES (1, 2);
INSERT INTO users (id) VALUES (2);
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;`;

async function flushAsyncUpdates() {
  for (let index = 0; index < 4; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
}

async function selectFiles(files: File[]) {
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flushAsyncUpdates();
}

async function mountDialogWithSqlFile(extraProps: Record<string, unknown> = {}, files = [new File([TABLEPLUS_STYLE_DUMP], "dump.sql")]) {
  const container = document.createElement("div");
  document.body.append(container);
  const state = reactive({ open: true, prefillConnectionId: "connection-1", prefillDatabase: "main", ...extraProps });
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(TableImportDialog, {
          ...state,
          "onUpdate:open": (value: boolean) => {
            state.open = value;
          },
        }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  i18n.global.locale.value = "en";
  app.mount(container);
  await flushAsyncUpdates();
  if (files.length) await selectFiles(files);
  return state;
}

beforeEach(() => {
  connectionStore.sqlFileSource = null;
  mocks.listTables.mockReset().mockResolvedValue([]);
  mocks.previewTableImportFile.mockReset();
  mocks.previewSqlFile.mockReset().mockResolvedValue({ uploadId: "uploaded-dump" });
  mocks.nativeOpen.mockReset();
  mocks.tauriRuntime = false;
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  vi.clearAllMocks();
});

describe("TableImportDialog SQL script fallback", () => {
  it("offers the SQL file executor for unsupported single-table SQL semantics", async () => {
    mocks.previewTableImportFile.mockRejectedValue(new Error(UNSUPPORTED_SQL_ERROR));

    await mountDialogWithSqlFile();

    expect(document.body.textContent).toContain(UNSUPPORTED_SQL_ERROR);
    const run = findButton("Execute SQL File");
    expect(run, "executor hand-off button").toBeTruthy();
    run!.click();
    await flushAsyncUpdates();

    expect(connectionStore.sqlFileSource).toMatchObject({ connectionId: "connection-1", database: "main", preview: { uploadId: "uploaded-dump" } });
  });

  it("offers the SQL file executor when importing into an existing table", async () => {
    mocks.previewTableImportFile.mockRejectedValue(new Error(UNSUPPORTED_SQL_ERROR));

    await mountDialogWithSqlFile({ prefillTable: "orders" });

    const run = findButton("Execute SQL File");
    expect(run, "executor hand-off button").toBeTruthy();
    run!.click();
    await flushAsyncUpdates();

    expect(connectionStore.sqlFileSource).toMatchObject({ connectionId: "connection-1", database: "main", preview: { uploadId: "uploaded-dump" } });
  });

  it.each([undefined, "orders"])("opens a single multi-table dump in the SQL file preview from target %s", async (prefillTable) => {
    mocks.previewTableImportFile.mockRejectedValue(new Error(MULTI_TABLE_ERROR));
    const file = new File([TABLEPLUS_STYLE_DUMP], "TablePlus-dump.SQL");
    const state = await mountDialogWithSqlFile({ prefillConnectionId: "mysql-1", prefillTable, prefillSchema: "app" }, [file]);
    expect(mocks.previewSqlFile).toHaveBeenCalledExactlyOnceWith(file);
    expect(connectionStore.sqlFileSource).toEqual({ connectionId: "mysql-1", database: "main", schema: "app", preview: { uploadId: "uploaded-dump" } });
    expect(state.open).toBe(false);
    expect(document.body.textContent).not.toContain(MULTI_TABLE_ERROR);
    expect(mocks.importTableFile).not.toHaveBeenCalled();
  });

  it("passes a native desktop dump path without uploading or executing it", async () => {
    mocks.tauriRuntime = true;
    mocks.nativeOpen.mockResolvedValue(["/Users/test/TablePlus-dump.sql"]);
    mocks.previewTableImportFile.mockRejectedValue(MULTI_TABLE_ERROR);
    const state = await mountDialogWithSqlFile({}, []);
    findButton(String(i18n.global.t("tableImport.selectFile")))!.click();
    await flushAsyncUpdates();
    expect(connectionStore.sqlFileSource).toEqual({ connectionId: "connection-1", database: "main", filePath: "/Users/test/TablePlus-dump.sql" });
    expect(mocks.previewSqlFile).not.toHaveBeenCalled();
    expect(mocks.importTableFile).not.toHaveBeenCalled();
    expect(state.open).toBe(false);
  });

  it("keeps a mixed file selection in the table import flow", async () => {
    mocks.previewTableImportFile.mockRejectedValue(new Error(MULTI_TABLE_ERROR));
    const state = await mountDialogWithSqlFile({}, [new File([TABLEPLUS_STYLE_DUMP], "dump.sql"), new File(["id\n1"], "rows.csv")]);
    expect(state.open).toBe(true);
    expect(connectionStore.sqlFileSource).toBeNull();
    expect(mocks.previewSqlFile).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(MULTI_TABLE_ERROR);
    expect(findButton("Execute SQL File")).toBeDefined();
  });

  it("keeps the original dump available for retry after an upload failure", async () => {
    mocks.previewTableImportFile.mockRejectedValue(new Error(MULTI_TABLE_ERROR));
    mocks.previewSqlFile.mockRejectedValueOnce(new Error("SQL upload failed"));
    const state = await mountDialogWithSqlFile();
    expect(state.open).toBe(true);
    expect(connectionStore.sqlFileSource).toBeNull();
    expect(document.body.textContent).toContain("SQL upload failed");
    expect(document.body.textContent).not.toContain(MULTI_TABLE_ERROR);
    findButton("Execute SQL File")!.click();
    await flushAsyncUpdates();
    expect(state.open).toBe(false);
    expect(connectionStore.sqlFileSource).toMatchObject({ preview: { uploadId: "uploaded-dump" } });
  });

  it("does not reopen a closed dialog when a dump upload finishes late", async () => {
    mocks.previewTableImportFile.mockRejectedValue(new Error(MULTI_TABLE_ERROR));
    let finish!: (value: { uploadId: string; cleanupToken: string }) => void;
    mocks.previewSqlFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const state = await mountDialogWithSqlFile();
    state.open = false;
    await flushAsyncUpdates();
    finish({ uploadId: "obsolete-dump", cleanupToken: "obsolete-upload" });
    await flushAsyncUpdates();
    expect(connectionStore.sqlFileSource).toBeNull();
    expect(state.open).toBe(false);
    expect(mocks.releaseSqlFilePreview).toHaveBeenCalledExactlyOnceWith("obsolete-upload");
  });

  it("does not hand a late dump upload to a different connection", async () => {
    mocks.previewTableImportFile.mockRejectedValue(new Error(MULTI_TABLE_ERROR));
    let finish!: (value: { uploadId: string }) => void;
    mocks.previewSqlFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const state = await mountDialogWithSqlFile();
    state.prefillConnectionId = "other-connection";
    state.prefillDatabase = "other-database";
    finish({ uploadId: "obsolete-dump" });
    await flushAsyncUpdates();
    expect(connectionStore.sqlFileSource).toBeNull();
    expect(state.open).toBe(true);
  });

  it("discards an upload that finishes after the import dialog unmounts", async () => {
    mocks.previewTableImportFile.mockRejectedValue(new Error(MULTI_TABLE_ERROR));
    let finish!: (value: { uploadId: string; cleanupToken: string }) => void;
    mocks.previewSqlFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await mountDialogWithSqlFile();
    expect(mocks.previewSqlFile).toHaveBeenCalledTimes(1);
    mountedApps.pop()!.unmount();
    finish({ uploadId: "obsolete-dump", cleanupToken: "unmounted-upload" });
    await flushAsyncUpdates();
    expect(connectionStore.sqlFileSource).toBeNull();
    expect(mocks.releaseSqlFilePreview).toHaveBeenCalledExactlyOnceWith("unmounted-upload");
  });

  it("ignores an old multi-table preview after another file is selected", async () => {
    let rejectPreview!: (reason: Error) => void;
    mocks.previewTableImportFile.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectPreview = reject;
        }),
    );
    const state = await mountDialogWithSqlFile();
    mocks.previewTableImportFile.mockResolvedValue({ fileName: "rows.csv", columns: ["id"], rows: [[1]], totalRows: 1 });
    await selectFiles([new File(["id\n1"], "rows.csv")]);
    rejectPreview(new Error(MULTI_TABLE_ERROR));
    await flushAsyncUpdates();
    expect(state.open).toBe(true);
    expect(connectionStore.sqlFileSource).toBeNull();
    expect(mocks.previewSqlFile).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(MULTI_TABLE_ERROR);
  });

  it("ignores an old dump upload after another file is selected", async () => {
    mocks.previewTableImportFile.mockRejectedValueOnce(new Error(MULTI_TABLE_ERROR));
    let finish!: (value: { uploadId: string }) => void;
    mocks.previewSqlFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const state = await mountDialogWithSqlFile();
    mocks.previewTableImportFile.mockResolvedValue({ fileName: "rows.csv", columns: ["id"], rows: [[1]], totalRows: 1 });
    await selectFiles([new File(["id\n1"], "rows.csv")]);
    finish({ uploadId: "obsolete-dump" });
    await flushAsyncUpdates();
    expect(state.open).toBe(true);
    expect(connectionStore.sqlFileSource).toBeNull();
  });

  it("leaves a successful single-table SQL file in the mapping wizard", async () => {
    mocks.previewTableImportFile.mockResolvedValue({ fileName: "orders.sql", columns: ["id"], rows: [[1]], totalRows: 1 });
    const state = await mountDialogWithSqlFile();
    expect(state.open).toBe(true);
    expect(connectionStore.sqlFileSource).toBeNull();
    expect(mocks.previewSqlFile).not.toHaveBeenCalled();
    expect(mocks.importTableFile).not.toHaveBeenCalled();
  });

  it("does not offer the executor for a delimited file that fails to preview", async () => {
    mocks.previewTableImportFile.mockRejectedValue(new Error("boom"));
    await mountDialogWithSqlFile();
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["id\n1"], "rows.csv")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flushAsyncUpdates();

    expect(document.body.textContent).toContain("boom");
    expect(findButton("Execute SQL File")).toBeUndefined();
  });
});
