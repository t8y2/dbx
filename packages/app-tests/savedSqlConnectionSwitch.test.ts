import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import ts from "typescript";
import { beforeEach, test, vi } from "vitest";
import { schemaAfterConnectionSwitch } from "../../apps/desktop/src/lib/schema/connectionSchemaInitialization.ts";
import { useQueryStore } from "../../apps/desktop/src/stores/queryStore.ts";
import { useSavedSqlStore } from "../../apps/desktop/src/stores/savedSqlStore.ts";
import type { SavedSqlFile } from "../../apps/desktop/src/types/database.ts";

const apiMock = vi.hoisted(() => ({
  loadSavedSqlLibrary: vi.fn(),
  loadSavedSqlFile: vi.fn(),
  saveSavedSqlFile: vi.fn<(file: SavedSqlFile) => Promise<SavedSqlFile>>(),
  closeClientConnectionSession: vi.fn(),
  listSchemas: vi.fn(),
}));
const toastMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/backend/api", () => apiMock);
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: toastMock }) }));

const appSource = readFileSync(new URL("../../apps/desktop/src/App.vue", import.meta.url), "utf8");
const functionSource = appSource.match(/async function changeActiveConnection\(tabId: string, connectionId: string\) \{[\s\S]*?\n\}\n\nfunction changeActiveDatabase/)?.[0].replace(/\n\nfunction changeActiveDatabase$/, "");
assert.ok(functionSource);
const switchSource = ts.transpileModule(functionSource, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [] });
  apiMock.saveSavedSqlFile.mockImplementation(async (file) => file);
  apiMock.closeClientConnectionSession.mockResolvedValue(undefined);
  apiMock.listSchemas.mockResolvedValue(["new_schema"]);
});

async function setupSwitch(databaseType = "mysql") {
  const savedSqlStore = useSavedSqlStore();
  const original = await savedSqlStore.saveFile({ connectionId: "conn-1", database: "db-1", schema: "old_schema", name: "report.sql", sql: "SELECT 1;" });
  const queryStore = useQueryStore();
  const tabId = queryStore.openSavedSql(original, { targetMode: "saved" });
  const tab = queryStore.tabs.find((candidate) => candidate.id === tabId)!;
  const ensureConnected = vi.fn().mockResolvedValue(undefined);
  const getDatabaseOptions = vi.fn().mockResolvedValue(["db-2"]);
  const rememberExternalSqlFileTarget = vi.fn();
  const connectionStore = {
    getConfig: (id: string) => ({ id, db_type: databaseType }),
    ensureConnected,
    activeConnectionId: "conn-1",
  };
  const changeActiveConnection = new Function(
    "resolveToolbarTab",
    "connectionStore",
    "resolveDefaultDatabase",
    "queryStore",
    "getDatabaseOptions",
    "rememberExternalSqlFileTarget",
    "schemaAfterConnectionSwitch",
    "api",
    "toast",
    "t",
    "translateBackendError",
    `${switchSource}\nreturn changeActiveConnection;`,
  )(
    (id: string) => queryStore.tabs.find((candidate) => candidate.id === id),
    connectionStore,
    (_connection: unknown, options: string[]) => options[0] ?? "",
    queryStore,
    getDatabaseOptions,
    rememberExternalSqlFileTarget,
    schemaAfterConnectionSwitch,
    apiMock,
    toastMock,
    (key: string) => key,
    (_translate: unknown, error: Error) => error.message,
  ) as (id: string, connectionId: string) => Promise<void>;
  return { savedSqlStore, original, queryStore, tab, tabId, ensureConnected, getDatabaseOptions, changeActiveConnection, rememberExternalSqlFileTarget };
}

test.each(["connect", "databases"])("a target-save rollback invalidates the pending %s continuation", async (stage) => {
  const context = await setupSwitch();
  await context.savedSqlStore.saveFile({ connectionId: "conn-2", database: "", name: "report.sql", sql: "SELECT 2;" });
  const pending = deferred<string[]>();
  if (stage === "connect") context.ensureConnected.mockReturnValue(pending.promise);
  else context.getDatabaseOptions.mockReturnValue(pending.promise);
  const change = context.changeActiveConnection(context.tabId, "conn-2");
  await vi.waitFor(() => assert.equal(context.tab.connectionId, "conn-1"));
  pending.resolve(["db-2"]);
  await change;
  assert.deepEqual([context.tab.connectionId, context.tab.database, context.tab.schema], ["conn-1", "db-1", "old_schema"]);
  assert.deepEqual([context.savedSqlStore.getFile(context.original.id)?.connectionId, context.savedSqlStore.getFile(context.original.id)?.database], ["conn-1", "db-1"]);
  assert.equal(toastMock.mock.calls.length, 1);
  if (stage === "connect") assert.equal(context.getDatabaseOptions.mock.calls.length, 0);
});

test.each(["database", "catalog", "schema"])("a newer %s selection invalidates a pending connection default", async (selection) => {
  const context = await setupSwitch();
  const databases = deferred<string[]>();
  context.getDatabaseOptions.mockReturnValue(databases.promise);
  const change = context.changeActiveConnection(context.tabId, "conn-2");
  await vi.waitFor(() => assert.equal(context.getDatabaseOptions.mock.calls.length, 1));
  if (selection === "database") context.queryStore.updateDatabase(context.tabId, "chosen");
  else if (selection === "catalog") context.queryStore.updateCatalog(context.tabId, "chosen", "catalog_db");
  else context.queryStore.updateSchema(context.tabId, "chosen");
  const target = [context.tab.connectionId, context.tab.database, context.tab.catalog, context.tab.schema];
  databases.resolve(["db-2"]);
  await change;
  assert.deepEqual([context.tab.connectionId, context.tab.database, context.tab.catalog, context.tab.schema], target);
});

test("changing a connection away and back does not revive its older default lookup", async () => {
  const context = await setupSwitch();
  const databases = deferred<string[]>();
  context.getDatabaseOptions.mockReturnValueOnce(databases.promise);
  const change = context.changeActiveConnection(context.tabId, "conn-2");
  await vi.waitFor(() => assert.equal(context.getDatabaseOptions.mock.calls.length, 1));
  context.queryStore.updateConnection(context.tabId, "conn-3", "");
  context.queryStore.updateConnection(context.tabId, "conn-2", "");
  databases.resolve(["stale_database"]);
  await change;
  assert.deepEqual([context.tab.connectionId, context.tab.database], ["conn-2", ""]);
});

test("a newer database selection invalidates a pending schema lookup", async () => {
  const context = await setupSwitch("oracle");
  const schemas = deferred<string[]>();
  apiMock.listSchemas.mockReturnValue(schemas.promise);
  const change = context.changeActiveConnection(context.tabId, "conn-2");
  await vi.waitFor(() => assert.equal(apiMock.listSchemas.mock.calls.length, 1));
  context.queryStore.updateDatabase(context.tabId, "chosen");
  schemas.resolve(["stale_schema"]);
  await change;
  assert.deepEqual([context.tab.database, context.tab.schema], ["chosen", undefined]);
});

test.each(["closed", "disposed"])("a %s tab no longer starts database metadata work", async (lifecycle) => {
  const context = await setupSwitch();
  const connect = deferred<void>();
  context.ensureConnected.mockReturnValue(connect.promise);
  const change = context.changeActiveConnection(context.tabId, "conn-2");
  if (lifecycle === "closed") context.queryStore.tabs.splice(context.queryStore.tabs.indexOf(context.tab), 1);
  else context.queryStore.$dispose();
  connect.resolve();
  await change;
  assert.equal(context.getDatabaseOptions.mock.calls.length, 0);
});

test("a superseded connection error does not notify for the newer target", async () => {
  const context = await setupSwitch();
  const connect = deferred<void>();
  context.ensureConnected.mockReturnValue(connect.promise);
  const change = context.changeActiveConnection(context.tabId, "conn-2");
  context.queryStore.updateConnection(context.tabId, "conn-3", "chosen");
  connect.reject(new Error("stale connection failed"));
  await change;
  assert.equal(toastMock.mock.calls.length, 0);
});

test("a successful switch still initializes its database and schema", async () => {
  const context = await setupSwitch("oracle");
  await context.changeActiveConnection(context.tabId, "conn-2");
  assert.deepEqual([context.tab.connectionId, context.tab.database, context.tab.schema], ["conn-2", "db-2", "new_schema"]);
  assert.equal(toastMock.mock.calls.length, 0);
  await vi.waitFor(() => assert.equal(context.savedSqlStore.getFile(context.original.id)?.schema, "new_schema"));
});

test("a current connection failure still notifies", async () => {
  const context = await setupSwitch();
  context.ensureConnected.mockRejectedValue(new Error("connection failed"));
  await context.changeActiveConnection(context.tabId, "conn-2");
  assert.equal(toastMock.mock.calls.length, 1);
  assert.equal(context.getDatabaseOptions.mock.calls.length, 0);
});

test("a database target rollback invalidates the pending schema result", async () => {
  const context = await setupSwitch("oracle");
  const schemas = deferred<string[]>();
  apiMock.listSchemas.mockReturnValue(schemas.promise);
  apiMock.saveSavedSqlFile.mockImplementation(async (file) => {
    if (file.database === "db-2") throw new Error("disk full");
    return file;
  });
  const change = context.changeActiveConnection(context.tabId, "conn-2");
  await vi.waitFor(() => assert.equal(toastMock.mock.calls.length, 1));
  const target = [context.tab.connectionId, context.tab.database, context.tab.schema];
  schemas.resolve(["stale_schema"]);
  await change;
  assert.deepEqual([context.tab.connectionId, context.tab.database, context.tab.schema], target);
});

test("an external SQL switch still remembers the initialized database and schema", async () => {
  const context = await setupSwitch("oracle");
  context.tab.savedSqlId = undefined;
  context.tab.externalSqlPath = "/tmp/report.sql";
  await context.changeActiveConnection(context.tabId, "conn-2");
  assert.deepEqual(context.rememberExternalSqlFileTarget.mock.calls.at(-1), ["/tmp/report.sql", { connectionId: "conn-2", database: "db-2", catalog: undefined, schema: "new_schema" }]);
  assert.equal(apiMock.saveSavedSqlFile.mock.calls.length, 1);
});
