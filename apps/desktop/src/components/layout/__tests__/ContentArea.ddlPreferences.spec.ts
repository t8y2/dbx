// @vitest-environment happy-dom

import { createApp, h, nextTick, shallowRef, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({ load: vi.fn(), format: vi.fn() }));
vi.mock("@/lib/metadata/objectDdlCache", () => ({ loadObjectDdl: mocks.load, invalidateObjectDdlCache: vi.fn() }));
vi.mock("@/lib/sql/ddlDisplay", async (original) => ({ ...(await original<object>()), formatDdlForDisplay: mocks.format }));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ __esModule: true, default: { render: () => null } }));
vi.mock("@/components/grid/DataGrid.vue", () => ({ __esModule: true, default: { render: () => null } }));
import ContentArea from "../ContentArea.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";

const ddl = 'CREATE  TABLE "Owner"."First" ("ID" NUMBER) PCTFREE 20 TABLESPACE "USERS";';
const apps: App[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockReset().mockResolvedValue({ ddl });
  mocks.format.mockReset().mockImplementation(async (sql: string) => sql);
  window.localStorage.clear();
  setActivePinia(createPinia());
});
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  window.localStorage.clear();
});
async function mountViewer(type: "oracle" | "oceanbase-oracle" = "oracle", separateIndexes = false, schema = "Owner", explicitOwner?: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = { id: "oracle-viewer", name: "Oracle", db_type: type, host: "localhost", port: 1, username: "test", password: "" } as ConnectionConfig;
  useConnectionStore().connections = [connection];
  const store = useQueryStore();
  const settings = useSettingsStore();
  settings.editorSettings.separateDdlIndexes = separateIndexes;
  const id = store.createTab(connection.id, "service", "DDL", "query", "Owner", "", undefined, { forceNew: true, sourceView: true });
  const tab = store.tabs.find((tab) => tab.id === id)!;
  tab.ddlViewer = { schema, explicitOwner, tableName: "First", formatDialect: "plsql" };
  const activeTab = shallowRef(tab);
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({ render: () => h(ContentArea, { activeTab: activeTab.value, activeConnection: connection, activeOutputView: "result", executableSql: "", formatSqlRequest: null, compressSqlRequest: null, selectedSql: "", cursorPos: 0, blockDangerousRedisCommands: false }) });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(container);
  apps.push(app);
  await vi.waitFor(() => expect(mocks.load).toHaveBeenCalled());
  return { tab, store, settings, container, activeTab };
}
function toggle(container: HTMLElement, option: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[id$="-${option}"]`);
  expect(button).not.toBeNull();
  expect(button!.disabled).toBe(false);
  button!.click();
}

it.each(["oracle", "oceanbase-oracle"] as const)("preserves %s explicit service-name owner on initial load and refresh", async (type) => {
  const { tab, store } = await mountViewer(type, true, "service", "service");
  await vi.waitFor(() => expect(tab.ddlLoad).toBeUndefined());
  expect(mocks.load.mock.calls[0][0]).toMatchObject({ schema: "service", explicitOwner: "service", separateIndexes: true });
  tab.ddlLoad = { startedAt: Date.now() };
  await store.loadDdlViewerTab(tab.id, true);
  expect(mocks.load.mock.lastCall?.[0]).toMatchObject({ schema: "service", explicitOwner: "service", separateIndexes: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it.each(["oracle", "oceanbase-oracle"] as const)("re-renders %s read-only DDL from its baseline without re-querying", async (type) => {
  const { tab, container } = await mountViewer(type);
  await vi.waitFor(() => expect(tab.ddlLoad).toBeUndefined());
  expect(tab.sql).not.toContain("PCTFREE");
  expect(tab.sql).toContain("CREATE TABLE");
  expect(tab.ddlViewer!.displaySource).toBe(ddl);
  toggle(container, "includeDdlStorage");
  await nextTick();
  expect(tab.sql).toContain('PCTFREE 20 TABLESPACE "USERS"');
  toggle(container, "compactDdlSql");
  await nextTick();
  expect(tab.sql).toBe(ddl);
  expect(tab.originalSql).toBe(tab.sql);
  expect(mocks.load).toHaveBeenCalledOnce();
});

it("reloads the same read-only tab for independent indexes and ignores the superseded result", async () => {
  const old = deferred<{ ddl: string }>();
  mocks.load.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ddl: 'CREATE TABLE "First" (id NUMBER);\nCREATE INDEX current_index ON "First"(id);' });
  const { tab, container } = await mountViewer();
  toggle(container, "separateDdlIndexes");
  await vi.waitFor(() => expect(tab.sql).toContain("current_index"));
  expect(mocks.load.mock.calls[1][0]).toMatchObject({ connectionId: tab.connectionId, database: "service", schema: "Owner", tableName: "First", separateIndexes: true });
  old.resolve({ ddl: "STALE" });
  await nextTick();
  await nextTick();
  expect(tab.sql).not.toContain("STALE");
  expect(tab.ddlViewer!.separateIndexes).toBe(true);
});

it("keeps the DDL option controls available after a failed independent-index reload", async () => {
  const { tab, container } = await mountViewer();
  await vi.waitFor(() => expect(tab.ddlLoad).toBeUndefined());
  mocks.load.mockRejectedValueOnce(new Error("index metadata unavailable")).mockResolvedValueOnce({ ddl });
  toggle(container, "separateDdlIndexes");
  await vi.waitFor(() => expect(tab.ddlLoad?.error).toBe("index metadata unavailable"));
  toggle(container, "separateDdlIndexes");
  await vi.waitFor(() => expect(tab.ddlLoad).toBeUndefined());
  expect(tab.sql).toContain("CREATE TABLE");
  expect(tab.ddlViewer!.separateIndexes).toBe(false);
});

it("returns to the loaded baseline when independent indexes are switched back off during loading", async () => {
  const { tab, container } = await mountViewer();
  await vi.waitFor(() => expect(tab.ddlLoad).toBeUndefined());
  const pending = deferred<{ ddl: string }>();
  mocks.load.mockReturnValueOnce(pending.promise);
  toggle(container, "separateDdlIndexes");
  await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
  toggle(container, "separateDdlIndexes");
  await nextTick();
  expect(tab.ddlLoad).toBeUndefined();
  expect(tab.sql).toContain("CREATE TABLE");
  pending.resolve({ ddl: "STALE INDEX RESULT" });
  await nextTick();
  await nextTick();
  expect(tab.sql).not.toContain("STALE");
  expect(tab.ddlViewer!.separateIndexes).toBe(false);
  expect(mocks.load).toHaveBeenCalledTimes(2);
});

it.each([
  { type: "oracle", initial: false, fail: false },
  { type: "oracle", initial: true, fail: true },
  { type: "oceanbase-oracle", initial: true, fail: false },
  { type: "oceanbase-oracle", initial: false, fail: true },
] as const)("reconciles a pending $type viewer (initial=$initial, failure=$fail) after preferences change on another tab", async ({ type, initial, fail }) => {
  const pending = deferred<{ ddl: string }>();
  const corrected = deferred<{ ddl: string }>();
  mocks.load.mockReturnValueOnce(pending.promise).mockReturnValueOnce(corrected.promise);
  const { tab, store, settings, activeTab } = await mountViewer(type, initial);
  const otherId = store.createTab(tab.connectionId!, "service", "Other", "query", "Owner", "", undefined, { forceNew: true });
  activeTab.value = store.tabs.find((candidate) => candidate.id === otherId)!;
  await nextTick();
  settings.editorSettings.separateDdlIndexes = !initial;
  await nextTick();
  activeTab.value = tab;
  await nextTick();
  if (fail) pending.reject(new Error("STALE FAILURE"));
  else pending.resolve({ ddl: "STALE INLINE DDL" });
  await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
  expect(tab.sql).not.toContain("STALE");
  expect(tab.ddlLoad).toBeDefined();
  expect(tab.ddlLoad?.error).toBeUndefined();
  expect(mocks.load.mock.calls[1][0].separateIndexes).toBe(!initial);
  corrected.resolve({ ddl: "CREATE TABLE CURRENT_TABLE (id NUMBER); CREATE INDEX CURRENT_INDEX ON CURRENT_TABLE(id);" });
  await vi.waitFor(() => expect(tab.ddlLoad).toBeUndefined());
  expect(tab.ddlViewer!.separateIndexes).toBe(!initial);
  expect(tab.sql).toContain("CURRENT_INDEX");
  expect(tab.originalSql).toBe(tab.sql);
});

it("rechecks preferences after asynchronous formatting before publishing", async () => {
  const formatting = deferred<string>();
  mocks.format.mockReturnValueOnce(formatting.promise);
  const { tab, store, settings, activeTab } = await mountViewer();
  await vi.waitFor(() => expect(mocks.format).toHaveBeenCalledOnce());
  const otherId = store.createTab(tab.connectionId!, "service", "Other", "query", "Owner", "", undefined, { forceNew: true });
  activeTab.value = store.tabs.find((candidate) => candidate.id === otherId)!;
  await nextTick();
  settings.editorSettings.separateDdlIndexes = true;
  await nextTick();
  formatting.resolve("STALE FORMATTED DDL");
  await vi.waitFor(() => expect(tab.ddlLoad).toBeUndefined());
  expect(mocks.load).toHaveBeenCalledTimes(2);
  expect(tab.sql).not.toContain("STALE");
  expect(tab.ddlViewer!.separateIndexes).toBe(true);
});

it.each(["close", "replace"] as const)("does not publish a corrected request after %s", async (action) => {
  const first = deferred<{ ddl: string }>();
  const corrected = deferred<{ ddl: string }>();
  const replacement = deferred<{ ddl: string }>();
  mocks.load.mockReturnValueOnce(first.promise).mockReturnValueOnce(corrected.promise).mockReturnValueOnce(replacement.promise);
  const { tab, store, settings, activeTab } = await mountViewer();
  const otherId = store.createTab(tab.connectionId!, "service", "Other", "query", "Owner", "", undefined, { forceNew: true });
  activeTab.value = store.tabs.find((candidate) => candidate.id === otherId)!;
  await nextTick();
  settings.editorSettings.separateDdlIndexes = true;
  await nextTick();
  first.resolve({ ddl: "STALE FIRST" });
  await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
  let pending;
  if (action === "close") store.closeTab(tab.id, { force: true });
  else {
    tab.ddlLoad = { startedAt: Date.now() };
    pending = tab.ddlLoad;
    void store.loadDdlViewerTab(tab.id);
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(3));
  }
  corrected.resolve({ ddl: "STALE CORRECTED" });
  await nextTick();
  await nextTick();
  expect(tab.sql).not.toContain("STALE");
  if (action === "close") expect(store.tabs.some((candidate) => candidate.id === tab.id)).toBe(false);
  else {
    expect(tab.ddlLoad).toBe(pending);
    replacement.resolve({ ddl: "CREATE TABLE REPLACEMENT (ID NUMBER);" });
    await vi.waitFor(() => expect(tab.ddlLoad).toBeUndefined());
    expect(tab.sql).toContain("REPLACEMENT");
  }
});
