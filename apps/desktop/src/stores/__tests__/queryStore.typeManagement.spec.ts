// @vitest-environment happy-dom
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OracleTypeManagementDraft } from "@/lib/table/oracleTypeManagement";
import type { ConnectionConfig, OracleTypeManagementSnapshot } from "@/types/database";

const mocks = vi.hoisted(() => ({ save: vi.fn(), load: vi.fn(), snapshot: vi.fn(), build: vi.fn(), getSource: vi.fn(), editableSource: vi.fn() }));
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  saveOpenTabsState: mocks.save,
  loadOpenTabsState: mocks.load,
  getOracleTypeManagementSnapshot: mocks.snapshot,
  buildOracleTypeManagementSql: mocks.build,
  getObjectSource: mocks.getSource,
  buildEditableObjectSource: mocks.editableSource,
  checkConnectionHealth: vi.fn(async () => {}),
  closeClientConnectionSession: vi.fn(async () => true),
  listDetachedTabHandoffs: vi.fn(async () => []),
  subscribeConnectionLiveness: vi.fn(async () => () => {}),
  subscribeConnectionIdleClosed: vi.fn(async () => () => {}),
}));

const target = { connectionId: "type-persist-test", database: "db", owner: "Mixed Owner", name: "Mixed Type", databaseType: "oceanbase-oracle" as const };
const source = 'CREATE OR REPLACE TYPE "Mixed Owner"."Mixed Type" AS OBJECT (ID NUMBER);';
const read = { state: "available" as const };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
let saved: { tabs: unknown[]; activeTabId: string | null };
let pinia: ReturnType<typeof createPinia>;

function snapshot(): OracleTypeManagementSnapshot {
  return {
    target: { connectionId: target.connectionId, database: target.database, owner: target.owner, name: target.name },
    visibilityScope: "current-user-visible-dictionaries",
    actingUser: target.owner,
    actingUserRead: read,
    detailsRead: read,
    typeSource: source,
    typeSourceRead: read,
    bodySource: null,
    bodySourceRead: read,
    objects: [{ owner: target.owner, name: target.name, objectType: "TYPE", exists: true, objectId: "9007199254740993", status: "VALID", statusRead: read, source, sourceRead: read, sourceFingerprint: source, errors: [], errorsRead: read, directPrivileges: [], privilegesRead: read }],
    dependencies: [],
    dependenciesRead: read,
    persistentReferences: [],
    persistentReferencesRead: read,
    directPrivileges: [],
    privilegesRead: read,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.stubGlobal(
    "EventSource",
    class extends EventTarget {
      onmessage = null;
      onerror = null;
      close() {}
    },
  );
  vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/api/tab-runtime-cache/prune")) return new Response(JSON.stringify({ deletedEntries: 0, deletedBytes: 0, orphanDeletions: 0, remainingEntries: 0, remainingBytes: 0 }), { status: 200 });
      if (String(url).startsWith("/api/tab-runtime-cache?key=") && init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`Unmocked HTTP boundary: ${String(url)}`);
    }),
  );
  pinia = createPinia();
  setActivePinia(pinia);
  saved = { tabs: [], activeTabId: null };
  mocks.save.mockImplementation(async (payload) => {
    saved = clone(payload);
  });
  mocks.load.mockImplementation(async () => clone(saved));
  mocks.snapshot.mockImplementation(async () => snapshot());
  mocks.build.mockImplementation(async (input) => ({ statements: [input.source], sourceFingerprint: input.source }));
  mocks.editableSource.mockImplementation(async (input) => input.source);
});

afterEach(async () => {
  disposePinia(pinia);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    vi
      .mocked(fetch)
      .mock.calls.filter(([url, init]) => !String(url).endsWith("/api/tab-runtime-cache/prune") && !(String(url).startsWith("/api/tab-runtime-cache?key=") && init?.method === "DELETE"))
      .map(([url]) => String(url)),
  ).toEqual([]);
  vi.unstubAllGlobals();
});

async function setup(loaded = true) {
  const { useQueryStore } = await import("@/stores/queryStore");
  const store = useQueryStore();
  if (loaded) await store.initOpenTabs();
  const tabId = store.openObjectSourceTab({ connectionId: target.connectionId, database: target.database, schema: target.owner, title: "TYPE source", sql: source, objectSource: { schema: target.owner, name: target.name, objectType: "TYPE" } });
  const { prepareOracleTypeManagement } = await import("@/lib/table/oracleTypeManagement");
  const plan = await prepareOracleTypeManagement(target, "save-spec", [{ owner: target.owner, name: target.name, objectType: "TYPE", source }]);
  return { store, tabId, plan };
}

describe("durable TYPE recovery through the real query store", () => {
  it.each([
    ["oracle", "TYPE"],
    ["oracle", "TYPE_BODY"],
    ["oceanbase-oracle", "TYPE"],
    ["oceanbase-oracle", "TYPE_BODY"],
    ["dameng", "TYPE"],
    ["dameng", "TYPE_BODY"],
  ] as const)("opens %s %s read-only by default with an explicit edit state and no generic SQL bypass", async (databaseType, objectType) => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const connections = useConnectionStore();
    connections.connections.push({ id: target.connectionId, name: "test", db_type: databaseType } as ConnectionConfig);
    connections.connectedIds.add(target.connectionId);
    mocks.getSource.mockResolvedValue({ name: target.name, object_type: objectType, source, editable: true });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    await store.initOpenTabs();
    const id = store.openObjectSourceTabPending({ connectionId: target.connectionId, database: target.database, schema: target.owner, title: "TYPE", initialEditing: false, request: { name: target.name, objectType } });
    await vi.waitFor(() => expect(store.tabs.find((tab) => tab.id === id)?.objectSource?.objectType).toBe(objectType));
    const tab = store.tabs.find((tab) => tab.id === id)!;
    expect(tab.sourceView).toBe(true);
    expect(tab.typeSourceEditing).toBe(false);
    expect(tab.objectDetails).toMatchObject({ connectionId: target.connectionId, database: target.database, schema: target.owner, name: target.name, objectType, section: "source" });
    await expect(store.executeTabSql(id, source)).rejects.toThrow();
    tab.typeSourceEditing = true;
    expect(tab.objectSource?.objectType).toBe(objectType);
  });
  it("awaits app_state saving and reads back the exact plan revision through the real serializer", async () => {
    const { store, tabId, plan } = await setup();
    mocks.save.mockClear();
    mocks.load.mockClear();
    await store.persistTypeManagementDraft(tabId, plan);
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.load).toHaveBeenCalledOnce();
    const tab = saved.tabs.find((value) => (value as { id: string }).id === tabId) as { typeManagementDraft: OracleTypeManagementDraft; objectDetails: unknown };
    expect(tab.typeManagementDraft.planId).toBe(plan.planId);
    expect(tab.typeManagementDraft.revision).toBe(plan.revision);
    expect(tab.typeManagementDraft.originalSnapshot.objects[0].objectId).toBe("9007199254740993");
    expect(tab.typeManagementDraft.drafts[0].source).toBe(source);
    const { restoreOpenTabsPayload } = await import("@/lib/app/openTabsPersistence");
    const restored = restoreOpenTabsPayload(saved).tabs.find((value) => value.id === tabId)!;
    expect(restored.objectDetails).toEqual(tab.objectDetails);
    expect(restored.objectDetails).toMatchObject({ name: target.name, schema: target.owner, objectType: "TYPE", section: "source" });
    expect(restored.typeManagementDraft?.planId).toBe(plan.planId);
    expect(restored.typeManagementDraft?.requiresReverify).toBe(true);
    expect(restored.typeSourceEditing).toBe(false);
    expect(store.tabs[0].sql).toBe(store.tabs[0].originalSql);
    expect(store.isTabDirty(store.tabs[0])).toBe(true);
  });

  it("rejects failed saving and a stale readback instead of reporting an empty success", async () => {
    const { store, tabId, plan } = await setup();
    mocks.save.mockRejectedValueOnce(new Error("disk full"));
    await expect(store.persistTypeManagementDraft(tabId, plan)).rejects.toThrow("disk full");
    mocks.load.mockResolvedValueOnce({ tabs: [], activeTabId: null });
    await expect(store.persistTypeManagementDraft(tabId, plan)).rejects.toThrow("app_state");
  });

  it("rejects an incomplete recovery payload even when its plan id and revision still match", async () => {
    const { store, tabId, plan } = await setup();
    const damaged = clone(plan);
    damaged.drafts[0].source = "A stored draft was lost";
    mocks.load.mockResolvedValueOnce({ tabs: [{ id: tabId, typeManagementDraft: damaged }], activeTabId: tabId });
    await expect(store.persistTypeManagementDraft(tabId, plan)).rejects.toThrow("app_state");
  });

  it("rejects unloaded, pending-source, mismatched or closed tabs before saving", async () => {
    const { store, tabId, plan } = await setup(false);
    await expect(store.persistTypeManagementDraft(tabId, plan)).rejects.toThrow("loaded main workspace");
    await store.initOpenTabs();
    const id = store.openObjectSourceTab({ connectionId: target.connectionId, database: target.database, schema: target.owner, title: "TYPE source", sql: source, objectSource: { schema: target.owner, name: target.name, objectType: "TYPE" } });
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.sourceLoad = { startedAt: 1, request: { name: target.name, objectType: "TYPE" } };
    await expect(store.persistTypeManagementDraft(id, plan)).rejects.toThrow("durable source tab");
    tab.sourceLoad = undefined;
    await expect(store.persistTypeManagementDraft(id, { ...plan, target: { ...target, owner: "OTHER" } })).rejects.toThrow("durable source tab");
    store.closeTab(id, { force: true });
    await expect(store.persistTypeManagementDraft(id, plan)).rejects.toThrow("durable source tab");
  });

  it.each(["none", "pinned"] as const)("retains an unfinished recovery manifest when ordinary tab restoration is %s", async (openTabsRestoreMode) => {
    const { store, tabId, plan } = await setup();
    const key = (name: string) => ({ owner: target.owner, name });
    const baseline = (name: string, rowCount: number, readOnly: boolean) => ({
      relation: { relation: key(name), objectId: "9007199254740993", readOnly, structure: `${name}-definition`, projection: [{ path: ["ID"], objectNull: false, dataType: "NUMBER(38,0)" }] },
      rowCount,
      fingerprint: "d".repeat(64),
    });
    const mapping = { id: "same-permanent-mapping", source: key("SRC"), old: key("OLD"), expected: key("EXPECTED"), target: key("RESULT"), fields: [{ sourcePath: ["ID"], objectNull: false, oldColumn: "ID", expectedColumn: "ID", targetPath: ["ID"], targetObjectNull: false, unchanged: true }] };
    plan.dataMappings = [
      { manifest: { mapping, original: baseline("SRC", 3, false), old: baseline("OLD", 3, true), expected: baseline("EXPECTED", 3, true), preparedTarget: baseline("RESULT", 0, false) }, insertSql: "bounded INSERT preview", insertDraft: "bounded INSERT preview", insertState: "sent" },
    ];
    plan.dataPreparation = { ...clone(mapping), id: "next-mapping", source: key("NEXT") };
    plan.dataTargetPaths = ['["ID"]'];
    plan.steps[0].state = "sent";
    await store.persistTypeManagementDraft(tabId, plan);
    disposePinia(pinia);
    pinia = createPinia();
    setActivePinia(pinia);
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().updateEditorSettings({ openTabsRestoreMode });
    const { useQueryStore } = await import("@/stores/queryStore");
    const restored = useQueryStore();
    await restored.initOpenTabs();
    expect(restored.tabs).toHaveLength(1);
    expect(restored.tabs[0].id).toBe(tabId);
    const record = restored.tabs[0].typeManagementDraft!;
    expect(record.planId).toBe(plan.planId);
    expect(record.executable).toBe(false);
    expect(record.requiresReverify).toBe(true);
    expect(record.steps[0].state).toBe("unknown");
    expect(record.originalSnapshot.objects[0].objectId).toBe("9007199254740993");
    expect(record.dataMappings[0].insertState).toBe("unknown");
    expect(record.dataMappings[0].manifest).toEqual(plan.dataMappings[0].manifest);
    expect(record.dataPreparation).toEqual(plan.dataPreparation);
    expect(record.dataTargetPaths).toEqual(plan.dataTargetPaths);
  });

  it("protects tab closure and detachment independently of ordinary dirty-SQL settings", async () => {
    const { store, tabId, plan } = await setup();
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().updateEditorSettings({ confirmUnsavedSqlClose: false, appCloseUnsavedTabsMode: "prompt" });
    await store.persistTypeManagementDraft(tabId, plan);
    await expect(store.prepareDetachedTab(tabId)).rejects.toThrow("main workspace");
    store.closeTab(tabId);
    expect(store.showCloseConfirm).toBe(true);
    expect(store.closeConfirmDirtyTabIds).toEqual([tabId]);
    store.cancelClosePendingTab();
    expect(store.tabs.some((tab) => tab.id === tabId)).toBe(true);
    expect(store.requiresAppCloseDraftPersist).toBe(true);
    expect(store.requestAppCloseConfirmation()).toBe(false);
  });

  it("rejects a different live plan and will not overwrite its original definitions", async () => {
    const { store, tabId, plan } = await setup();
    await store.persistTypeManagementDraft(tabId, plan);
    await expect(store.persistTypeManagementDraft(tabId, { ...clone(plan), planId: "other-plan" })).rejects.toThrow("existing TYPE recovery plan");
    expect(store.tabs[0].typeManagementDraft?.planId).toBe(plan.planId);
  });

  it("does not allow generic SQL execution or forced tab closure to discard an in-flight recovery record", async () => {
    const { store, tabId, plan } = await setup();
    plan.state = "running";
    plan.steps[0].state = "sent";
    await store.persistTypeManagementDraft(tabId, plan);
    await expect(store.executeTabSql(tabId, source)).rejects.toThrow();
    store.closeTab(tabId, { force: true });
    expect(store.tabs.some((tab) => tab.id === tabId)).toBe(true);
    expect(store.tabs[0].typeManagementDraft?.steps[0].state).toBe("sent");
  });

  it("preserves an existing recovery record during a pending source reload but does not permit another write", async () => {
    const { store, tabId, plan } = await setup();
    await store.persistTypeManagementDraft(tabId, plan);
    store.tabs[0].sourceLoad = { startedAt: 1, request: { name: target.name, objectType: "TYPE" } };
    await store.flushPendingPersist();
    const persisted = saved.tabs.find((tab) => (tab as { id: string }).id === tabId) as { sourceLoad?: unknown; typeManagementDraft: OracleTypeManagementDraft };
    expect(persisted.typeManagementDraft.planId).toBe(plan.planId);
    expect(persisted.sourceLoad).toBeUndefined();
    await expect(store.persistTypeManagementDraft(tabId, plan)).rejects.toThrow("durable source tab");
  });
});
