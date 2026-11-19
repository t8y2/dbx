// @vitest-environment happy-dom
import { createApp, defineComponent, h, type App } from "vue";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSqlFilePicker } from "@/composables/useSqlFilePicker";
import { useQueryStore } from "@/stores/queryStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { rememberExternalSqlFileTarget } from "@/lib/sql/externalSqlFileTarget";
import { ExternalSqlFileTooLargeError } from "@/lib/sql/sqlFileOpen";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({ desktop: true, open: vi.fn(), read: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => mocks.desktop }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@/lib/backend/api", async (importOriginal) => ({ ...(await importOriginal<object>()), readExternalSqlFileSnapshot: mocks.read }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

const version = { sizeBytes: 19, modifiedNs: "123", contentHash: "file-b" };
let pinia: ReturnType<typeof createPinia>;
let app: App;
let queryStore: ReturnType<typeof useQueryStore>;
let connectionStore: ReturnType<typeof useConnectionStore>;
let openSqlFile: () => Promise<void>;
let browserInput: HTMLInputElement | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.desktop = true;
  mocks.open.mockReset().mockResolvedValue("/tmp/repro-b.sql");
  mocks.read.mockReset().mockResolvedValue({ content: "SELECT 2 AS file_b;", version, encoding: "utf-8" });
  browserInput = undefined;
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
  pinia = createPinia();
  setActivePinia(pinia);
  queryStore = useQueryStore();
  connectionStore = useConnectionStore();
  connectionStore.connections = [
    { id: "pg", name: "Postgres", db_type: "postgres" },
    { id: "other", name: "Other Postgres", db_type: "postgres" },
    { id: "mongo", name: "Mongo", db_type: "mongodb" },
  ] as ConnectionConfig[];
  app = createApp(
    defineComponent({
      setup() {
        ({ openSqlFile } = useSqlFilePicker());
        return () => h("button", { onClick: openSqlFile }, "Open SQL file");
      },
    }),
  );
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", missingWarn: false, fallbackWarn: false, messages: { en: {} } }));
  app.mount(document.createElement("div"));
});

afterEach(() => {
  app.unmount();
  disposePinia(pinia);
  vi.restoreAllMocks();
  localStorage.clear();
});

function draft() {
  const id = queryStore.createTab("pg", "app", "Original", "query", "reporting", "SELECT 1;", "catalog");
  queryStore.updateSql(id, "SELECT 1 AS unsaved_query;");
  return queryStore.tabs.find((tab) => tab.id === id)!;
}

async function requestBrowserFile() {
  await openSqlFile();
  browserInput = vi.mocked(HTMLInputElement.prototype.click).mock.contexts.at(-1) as HTMLInputElement | undefined;
  expect(browserInput).toBeDefined();
}

async function selectBrowserFile(name: string, content: string) {
  await requestBrowserFile();
  Object.defineProperty(browserInput!, "files", { configurable: true, value: [new File([content], name)] });
  await browserInput!.onchange!.call(browserInput!, new Event("change"));
}

describe("SQL file picker", () => {
  it("opens a desktop file in a new tab and preserves the unsaved query and its source", async () => {
    const original = draft();
    await openSqlFile();

    expect(queryStore.tabs).toHaveLength(2);
    expect(original).toMatchObject({ sql: "SELECT 1 AS unsaved_query;", originalSql: "SELECT 1;", connectionId: "pg", database: "app", schema: "reporting", catalog: "catalog" });
    expect(original.externalSqlPath).toBeUndefined();
    const opened = queryStore.tabs.find((tab) => tab.id === queryStore.activeTabId)!;
    expect(opened.id).not.toBe(original.id);
    expect(opened).toMatchObject({
      title: "repro-b.sql",
      sql: "SELECT 2 AS file_b;",
      originalSql: "SELECT 2 AS file_b;",
      externalSqlPath: "/tmp/repro-b.sql",
      externalSqlFileVersion: version,
      externalSqlEncoding: "utf-8",
      connectionId: "pg",
      database: "app",
      schema: "reporting",
      catalog: "catalog",
    });
    expect(queryStore.groups.find((group) => group.id === queryStore.focusedGroupId)).toMatchObject({ activeTabId: opened.id, tabIds: [original.id, opened.id] });
  });

  it("opens without an existing query or database connection", async () => {
    connectionStore.connections = [];
    await openSqlFile();
    expect(queryStore.tabs).toHaveLength(1);
    expect(queryStore.tabs[0]).toMatchObject({ connectionId: "", database: "", externalSqlPath: "/tmp/repro-b.sql", sql: "SELECT 2 AS file_b;" });
  });

  it("reopening a dirty file only activates its existing tab and preserves its target", async () => {
    const fileId = queryStore.openExternalSqlFile("other", "saved", "/tmp/repro-b.sql", "SELECT 0;", version, "old-catalog", "old-schema", undefined, "gb18030");
    queryStore.updateSql(fileId, "SELECT 'unsaved file';");
    const original = draft();
    await openSqlFile();
    expect(queryStore.tabs).toHaveLength(2);
    expect(queryStore.activeTabId).toBe(fileId);
    expect(queryStore.tabs.find((tab) => tab.id === fileId)).toMatchObject({ sql: "SELECT 'unsaved file';", originalSql: "SELECT 0;", connectionId: "other", database: "saved", schema: "old-schema", catalog: "old-catalog", externalSqlEncoding: "gb18030" });
    expect(original.sql).toBe("SELECT 1 AS unsaved_query;");
  });

  it("keeps different desktop files with the same basename in separate tabs", async () => {
    queryStore.openExternalSqlFile("pg", "app", "/other/repro-b.sql", "SELECT 0;");
    await openSqlFile();
    expect(queryStore.tabs.map((tab) => tab.externalSqlPath)).toEqual(["/other/repro-b.sql", "/tmp/repro-b.sql"]);
    expect(queryStore.tabs[0].sql).toBe("SELECT 0;");
    expect(new Set(queryStore.tabs.map((tab) => tab.title)).size).toBe(2);
  });

  it("restores a file's remembered database, catalog and schema", async () => {
    draft();
    rememberExternalSqlFileTarget("/tmp/repro-b.sql", { connectionId: "other", database: "saved", catalog: "saved-catalog", schema: "saved-schema" });
    await openSqlFile();
    expect(queryStore.tabs.find((tab) => tab.id === queryStore.activeTabId)).toMatchObject({ connectionId: "other", database: "saved", catalog: "saved-catalog", schema: "saved-schema" });
  });

  it("keeps the initiating query's target when tabs change while the picker is open", async () => {
    draft();
    let select!: (path: string) => void;
    mocks.open.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          select = resolve;
        }),
    );
    const pending = openSqlFile();
    await vi.waitFor(() => expect(select).toBeDefined());
    queryStore.createTab("other", "changed", "Different query", "query", "changed-schema");
    select("/tmp/repro-b.sql");
    await pending;
    expect(queryStore.tabs.find((tab) => tab.id === queryStore.activeTabId)).toMatchObject({ connectionId: "pg", database: "app", catalog: "catalog", schema: "reporting" });
  });

  it.each(["cancel", "read failure"])("does not change tabs on desktop %s", async (scenario) => {
    const original = draft();
    if (scenario === "cancel") mocks.open.mockResolvedValue(null);
    else mocks.read.mockRejectedValue(new Error("Cannot read file"));
    await openSqlFile();
    expect(queryStore.tabs).toHaveLength(1);
    expect(queryStore.activeTabId).toBe(original.id);
    expect(original.sql).toBe("SELECT 1 AS unsaved_query;");
    expect(original.externalSqlPath).toBeUndefined();
    expect(mocks.toast).toHaveBeenCalledTimes(scenario === "cancel" ? 0 : 1);
  });

  it("retains the streaming executor fallback for oversized desktop SQL files", async () => {
    const original = draft();
    mocks.read.mockRejectedValue(new ExternalSqlFileTooLargeError(100 * 1024 * 1024, 64 * 1024 * 1024));
    await openSqlFile();
    expect(queryStore.tabs).toHaveLength(1);
    expect(original.sql).toBe("SELECT 1 AS unsaved_query;");
    expect(connectionStore.sqlFileSource).toMatchObject({ connectionId: "pg", database: "app", schema: "reporting", filePath: "/tmp/repro-b.sql" });
  });

  it("preserves MongoDB script filters and opens scripts in a separate query", async () => {
    const id = queryStore.createTab("mongo", "documents", "Original script", "query", undefined, "db.a.find()");
    mocks.open.mockResolvedValue("/tmp/query.js");
    await openSqlFile();
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ filters: expect.arrayContaining([{ name: "MongoDB Script", extensions: ["js"] }]) }));
    expect(queryStore.tabs).toHaveLength(2);
    expect(queryStore.tabs.find((tab) => tab.id === id)?.sql).toBe("db.a.find()");
    expect(queryStore.tabs.find((tab) => tab.id === queryStore.activeTabId)).toMatchObject({ connectionId: "mongo", database: "documents", externalSqlPath: "/tmp/query.js" });
  });

  it("opens same-named browser files separately without replacing the original query", async () => {
    mocks.desktop = false;
    const original = draft();
    await selectBrowserFile("query.sql", "SELECT 2;");
    await selectBrowserFile("query.sql", "SELECT 3;");
    expect(queryStore.tabs).toHaveLength(3);
    expect(original.sql).toBe("SELECT 1 AS unsaved_query;");
    expect(queryStore.tabs.slice(1).map((tab) => ({ sql: tab.sql, originalSql: tab.originalSql, title: tab.title, externalSqlPath: tab.externalSqlPath, schema: tab.schema }))).toEqual([
      { sql: "SELECT 2;", originalSql: "SELECT 2;", title: "query.sql", externalSqlPath: undefined, schema: "reporting" },
      { sql: "SELECT 3;", originalSql: "SELECT 3;", title: "query.sql", externalSqlPath: undefined, schema: "reporting" },
    ]);
  });

  it("opens a browser file without a query or connection", async () => {
    mocks.desktop = false;
    connectionStore.connections = [];
    await selectBrowserFile("query.sql", "SELECT 2;");
    expect(queryStore.tabs).toHaveLength(1);
    expect(queryStore.tabs[0]).toMatchObject({ sql: "SELECT 2;", connectionId: "", database: "" });
  });

  it("does not create a browser tab when selection is cancelled or the file exceeds the editor limit", async () => {
    mocks.desktop = false;
    const original = draft();
    await requestBrowserFile();
    Object.defineProperty(browserInput!, "files", { configurable: true, value: [] });
    await browserInput!.onchange!.call(browserInput!, new Event("change"));
    expect(queryStore.tabs).toHaveLength(1);
    const largeFile = new File(["SELECT 2;"], "large.sql");
    Object.defineProperty(largeFile, "size", { value: 100 * 1024 * 1024 });
    Object.defineProperty(browserInput!, "files", { configurable: true, value: [largeFile] });
    await browserInput!.onchange!.call(browserInput!, new Event("change"));
    expect(queryStore.tabs).toHaveLength(1);
    expect(original.sql).toBe("SELECT 1 AS unsaved_query;");
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });
});
