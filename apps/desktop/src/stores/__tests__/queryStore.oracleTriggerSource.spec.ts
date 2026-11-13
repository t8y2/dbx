import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, ObjectSource, TreeNode, TriggerInfo } from "@/types/database";

const rpc = vi.hoisted(() => ({
  getObjectSource: vi.fn(),
  executeQuery: vi.fn(),
  prepareOracleTriggerSql: vi.fn(),
  checkConnectionHealth: vi.fn(async () => undefined),
  loadSchemaCache: vi.fn(async () => null),
  saveSchemaCache: vi.fn(async () => undefined),
  deleteSchemaCachePrefix: vi.fn(async () => undefined),
  saveOpenTabsState: vi.fn(async () => undefined),
  closeQuerySession: vi.fn(async () => undefined),
  closeClientConnectionSession: vi.fn(async () => undefined),
  listInstalledAgents: vi.fn(async () => []),
}));
vi.mock("@/lib/backend/api", () => rpc);
const ddl = 'CREATE OR REPLACE TRIGGER "Owner"."Trigger" BEFORE UPDATE ON "Parent"."T" DISABLE BEGIN NULL; END;';
let raw: ObjectSource;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  setActivePinia(createPinia());
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const connections = useConnectionStore();
  connections.connections = [{ id: "source-trigger", name: "test", db_type: "oceanbase-oracle", username: "Owner", database: "service" } as ConnectionConfig];
  connections.connectedIds.add("source-trigger");
  raw = {
    name: "Trigger",
    schema: "Owner",
    object_type: "TRIGGER",
    source: ddl,
    editable: false,
    trigger: {
      name: "Trigger",
      event: "UPDATE",
      timing: "BEFORE",
      enabled: false,
      valid: true,
      oracle_metadata: {
        contractVersion: 1,
        identityMode: "exact",
        engine: "oceanbase-oracle",
        engineVersion: "4.2.5.7_107",
        owner: "Owner",
        name: "Trigger",
        objectId: "9007199254740993",
        scope: "TABLE",
        parent: { owner: "Parent", name: "T", objectType: "TABLE" },
        definition: { origin: "DBMS_METADATA", format: "ddl", complete: true },
        reads: { identity: { state: "available" }, scope: { state: "available" }, parent: { state: "available" }, enabled: { state: "available" }, validity: { state: "available" }, definition: { state: "available" }, errors: { state: "available" } },
        errors: [],
      },
    },
  };
  rpc.getObjectSource.mockImplementation(async () => JSON.parse(JSON.stringify(raw)));
  rpc.prepareOracleTriggerSql.mockImplementation(async (input) => ({ definition: input.source, comparisonSource: input.source, header: { scope: "RELATION", owner: "Parent", name: "T", viewOnly: false, pluggable: false }, requiresStateRestore: false }));
  rpc.executeQuery.mockImplementation(async (_id, _db, sql) => (sql.startsWith("SELECT") ? { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [["Parent", "T", "TABLE", "parent-id"]] } : { columns: [], rows: [] }));
});
async function open() {
  const { useQueryStore } = await import("@/stores/queryStore");
  const store = useQueryStore();
  const id = store.openObjectSourceTabPending({ connectionId: "source-trigger", database: "service", schema: "Owner", title: "Trigger", request: { name: "Trigger", objectType: "TRIGGER" } });
  await vi.waitFor(() => expect(store.tabs.find((tab) => tab.id === id)?.objectSource).toBeDefined());
  return { store, id, tab: store.tabs.find((tab) => tab.id === id)! };
}
describe("exact trigger bound source tabs", () => {
  it("does not let a delayed native readback overwrite the next container's verified tree state", async () => {
    const { store, id, tab } = await open();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { buildSimpleObjectTreeNodes } = await import("@/lib/table/tableTree");
    const connections = useConnectionStore();
    connections.treeNodes = buildSimpleObjectTreeNodes({ nodeId: "schema", connectionId: "source-trigger", database: "service", schema: "Owner", objects: [{ name: raw.name, schema: raw.schema, object_type: "TRIGGER", trigger: structuredClone(raw.trigger) }] });
    store.updateSql(id, ddl + "\n-- keep my draft");
    let release!: () => void;
    const invalidation = vi
      .spyOn(connections, "invalidateOracleTriggerLists")
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    rpc.executeQuery.mockImplementation(async (_id, _db, sql) => {
      raw.trigger!.enabled = sql.endsWith(" ENABLE;");
      return { columns: [], rows: [] };
    });
    const { useSqlExecutionDangerStore } = await import("@/stores/sqlExecutionDangerStore");
    const danger = useSqlExecutionDangerStore();
    const first = store.runOracleTriggerSourceAction(id, "enable");
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    danger.confirm();
    await vi.waitFor(() => expect(release).toBeDefined());
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const secondPlan = await prepareOracleTriggerPlan({ target: { connectionId: "source-trigger", database: "service", owner: "Owner", name: "Trigger", executionSchema: "Owner" }, action: "disable" });
    const second = await executeOracleTriggerPlan(secondPlan, { confirmed: true, isCurrent: () => true });
    expect(second.steps[0].state).toBe("committed");
    expect((connections.treeNodes[0].meta as TriggerInfo).enabled).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(store.oracleTriggerSourceState(id)?.result?.steps[0]).toMatchObject({ state: "committed", verification: "applied" });
    expect((connections.treeNodes[0].meta as TriggerInfo).enabled).toBe(false);
    expect(rpc.executeQuery.mock.calls.map((call) => call[2])).toEqual(['ALTER TRIGGER "Owner"."Trigger" ENABLE;', 'ALTER TRIGGER "Owner"."Trigger" DISABLE;']);
    expect(tab.sql).toBe(ddl + "\n-- keep my draft");
    invalidation.mockRestore();
  });

  it.each(["committed", "unknown", "recreated"])("updates only the verified physical tree entries after a bound native action (%s)", async (outcome) => {
    const { store, id, tab } = await open();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { buildSimpleObjectTreeNodes } = await import("@/lib/table/tableTree");
    const connections = useConnectionStore();
    const node = buildSimpleObjectTreeNodes({ nodeId: "schema", connectionId: "source-trigger", database: "service", schema: "Owner", objects: [{ name: raw.name, schema: raw.schema, object_type: "TRIGGER", trigger: structuredClone(raw.trigger) }] })[0];
    const parentCopy = { ...structuredClone(node), id: "parent-copy" };
    const recreated = { ...structuredClone(node), id: "new-physical" };
    (recreated.meta as TriggerInfo).oracle_metadata!.objectId = "other-id";
    const otherCatalog = { ...structuredClone(node), id: "other-catalog", catalog: "Other" };
    const otherOwner = { ...structuredClone(node), id: "other-owner", schema: "Other" };
    (otherOwner.meta as TriggerInfo).oracle_metadata!.owner = "Other";
    connections.treeNodes = [{ id: "root", type: "connection", label: "test", children: [node, parentCopy, recreated, otherCatalog, otherOwner] } as TreeNode];
    store.updateSql(id, ddl + "\n-- keep my draft");
    rpc.executeQuery.mockImplementation(async (_id, _db, sql) => {
      if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [["Parent", "T", "TABLE", "parent-id"]] };
      raw.trigger!.enabled = true;
      raw.trigger!.valid = false;
      if (outcome === "unknown") throw new Error("reply lost");
      if (outcome === "recreated") raw.trigger!.oracle_metadata!.objectId = "replacement-id";
      return { columns: [], rows: [] };
    });
    const { useSqlExecutionDangerStore } = await import("@/stores/sqlExecutionDangerStore");
    const danger = useSqlExecutionDangerStore();
    const pending = store.runOracleTriggerSourceAction(id, "enable");
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    danger.confirm();
    await pending;
    const children = connections.treeNodes[0].children!;
    for (const index of [0, 1]) {
      expect(children[index]).toMatchObject({ valid: outcome !== "committed", meta: { enabled: outcome === "committed", valid: outcome !== "committed" } });
      if (outcome === "committed") expect(children[index]).not.toBe(index === 0 ? node : parentCopy);
    }
    expect(children.slice(2)).toEqual([recreated, otherCatalog, otherOwner]);
    expect(tab.sql).toBe(ddl + "\n-- keep my draft");
    expect(rpc.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT"))).toHaveLength(1);
  });

  it("rejects a native action on a same-name replacement before opening confirmation", async () => {
    const { store, id, tab } = await open();
    raw.trigger!.oracle_metadata!.objectId = "replacement-id";
    const { useSqlExecutionDangerStore } = await import("@/stores/sqlExecutionDangerStore");
    const danger = useSqlExecutionDangerStore();
    let settled = false;
    const pending = store.runOracleTriggerSourceAction(id, "compile").finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(settled || !!danger.pending).toBe(true));
    const confirmed = !!danger.pending;
    danger.cancelAll();
    await pending;
    expect(confirmed).toBe(false);
    expect(store.oracleTriggerSourceState(id)?.baseline?.metadata.objectId).toBe("9007199254740993");
    expect(tab.sql).toBe(ddl);
    expect(rpc.executeQuery).not.toHaveBeenCalled();
  });

  it.each(["identity", "definition"])("retains the loaded baseline when native readback finds changed %s after dispatch", async (change) => {
    const { store, id, tab } = await open();
    store.updateSql(id, ddl + "\n-- keep my draft");
    const draft = tab.sql;
    rpc.executeQuery.mockImplementation(async () => {
      if (change === "identity") raw.trigger!.oracle_metadata!.objectId = "replacement-id";
      else raw.source = ddl.replace("NULL;", "other_session_proc;");
      return { columns: [], rows: [] };
    });
    const { useSqlExecutionDangerStore } = await import("@/stores/sqlExecutionDangerStore");
    const danger = useSqlExecutionDangerStore();
    const pending = store.runOracleTriggerSourceAction(id, "compile");
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    danger.confirm();
    await expect(pending).resolves.toBe(false);
    expect(store.oracleTriggerSourceState(id)?.result?.steps[0]).toMatchObject({ state: "unknown", verification: "mismatch" });
    expect(store.oracleTriggerSourceState(id)?.baseline?.metadata.objectId).toBe("9007199254740993");
    expect(store.oracleTriggerSourceState(id)?.baseline?.raw.source).toBe(ddl);
    expect(store.oracleTriggerSourceState(id)?.error).toContain("reload");
    expect(tab.sql).toBe(draft);
    expect(store.isTabDirty(tab)).toBe(true);
    expect(rpc.executeQuery).toHaveBeenCalledOnce();
  });

  it.each([false, true])("keeps dispatched native results on the originating read generation (refresh=%s)", async (refresh) => {
    const { store, id, tab } = await open();
    store.updateSql(id, ddl + "\n-- original dirty draft");
    const draft = tab.sql;
    let finish!: () => void;
    rpc.executeQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ columns: [], rows: [] });
        }),
    );
    const { useSqlExecutionDangerStore } = await import("@/stores/sqlExecutionDangerStore");
    const danger = useSqlExecutionDangerStore();
    const pending = store.runOracleTriggerSourceAction(id, "compile");
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    danger.confirm();
    await vi.waitFor(() => expect(finish).toBeDefined());
    const otherId = store.createTab("source-trigger", "service", "Other", "query", "Other", "SELECT 42");
    if (refresh) {
      store.refreshObjectSourceTab(id);
      // The existing physical source lock rejects a reload while DDL is in flight.
      await vi.waitFor(() => expect(tab.sourceLoad?.error).toBeTruthy());
    }
    finish();
    await expect(pending).resolves.toBe(true);
    if (refresh) expect(store.oracleTriggerSourceState(id)?.result).toBeUndefined();
    else expect(store.oracleTriggerSourceState(id)?.result?.steps[0]).toMatchObject({ state: "committed", verification: "valid" });
    expect(tab.sql).toBe(draft);
    expect(store.isTabDirty(tab)).toBe(true);
    expect(store.tabs.find((item) => item.id === otherId)?.sql).toBe("SELECT 42");
    expect(store.oracleTriggerSourceState(otherId)).toBeUndefined();
    expect(rpc.executeQuery).toHaveBeenCalledOnce();
    if (refresh) {
      store.refreshObjectSourceTab(id);
      await vi.waitFor(() => expect(tab.sourceLoad).toBeUndefined());
      expect(tab.sql).toBe(draft);
      expect(store.oracleTriggerSourceState(id)?.result).toBeUndefined();
    }
  });

  it("invalidates unissued native confirmation as soon as a source refresh starts", async () => {
    const { store, id, tab } = await open();
    const { useSqlExecutionDangerStore } = await import("@/stores/sqlExecutionDangerStore");
    const danger = useSqlExecutionDangerStore();
    const pending = store.runOracleTriggerSourceAction(id, "compile");
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    let finish!: () => void;
    rpc.getObjectSource.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(JSON.parse(JSON.stringify(raw)));
        }),
    );
    store.refreshObjectSourceTab(id);
    const confirmationStillOpen = !!danger.pending;
    danger.cancelAll();
    await expect(pending).resolves.toBe(false);
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish();
    await vi.waitFor(() => expect(tab.sourceLoad).toBeUndefined());
    expect(confirmationStillOpen).toBe(false);
    expect(rpc.executeQuery).not.toHaveBeenCalled();
  });

  it("uses the existing one-shot editor reveal without changing a dirty source or guessing a replacement identity", async () => {
    raw.source = raw.source.replace("CREATE OR REPLACE ", "");
    raw.trigger!.oracle_metadata!.definition = { origin: "ALL_SOURCE", format: "declaration", complete: true };
    const { store, id, tab } = await open();
    store.updateSql(id, "-- unsaved comment\nCREATE OR REPLACE " + raw.source);
    const draft = tab.sql;
    const position = raw.source.indexOf("BEGIN") + 1;
    expect(store.revealOracleTriggerSourceError(id, { line: 1, position }, "9007199254740993")).toBe(true);
    expect(tab.editorRevealRequest).toMatchObject({ line: 2, column: tab.sql.split("\n")[1].indexOf("BEGIN") + 1 });
    expect(tab.sql).toBe(draft);
    expect(store.isTabDirty(tab)).toBe(true);
    tab.editorRevealRequest = undefined;
    expect(store.revealOracleTriggerSourceError(id, { line: 1, position }, "replacement-id")).toBe(false);
    expect(tab.editorRevealRequest).toBeUndefined();
    expect(rpc.executeQuery).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps diagnostic readback on its original tab and preserves the loaded baseline when external source changed (%s)", async (changed) => {
    const { store, id, tab } = await open();
    const loaded = store.oracleTriggerSourceState(id)!.baseline!;
    store.updateSql(id, tab.sql + "\n-- keep my draft");
    const draft = tab.sql;
    if (changed) raw.source += "\n-- another session's source";
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const plan = await prepareOracleTriggerPlan({ target: loaded.target, action: "compile", expectedObjectId: loaded.metadata.objectId! });
    const otherId = store.createTab("source-trigger", "service", "Other", "query", "Other", "SELECT 42");
    const other = store.tabs.find((item) => item.id === otherId)!;
    const result = await executeOracleTriggerPlan(plan, { confirmed: true, isCurrent: () => true });
    const readVersion = store.oracleTriggerSourceState(id)?.readVersion;
    store.acceptOracleTriggerDiagnosticResult(id, result, plan.before, readVersion);
    expect(store.oracleTriggerSourceState(id)?.result?.steps[0].state).toBe("committed");
    expect(store.oracleTriggerSourceState(id)?.baseline?.raw.source).toBe(changed ? loaded.raw.source : result.snapshot!.raw.source);
    if (changed) expect(store.oracleTriggerSourceState(id)?.error).toContain("reload");
    expect(store.oracleTriggerSourceState(id)?.readVersion).toBe(readVersion);
    expect(tab.sql).toBe(draft);
    expect(store.isTabDirty(tab)).toBe(true);
    expect(other.sql).toBe("SELECT 42");
    expect(store.oracleTriggerSourceState(otherId)).toBeUndefined();
    const previousResult = store.oracleTriggerSourceState(id)!.result;
    store.refreshObjectSourceTab(id);
    store.acceptOracleTriggerDiagnosticResult(id, { ...result, refreshError: "late stale feedback" }, plan.before, readVersion);
    expect(store.oracleTriggerSourceState(id)?.result).toBe(previousResult);
    await vi.waitFor(() => expect(tab.sourceLoad).toBeUndefined());
    expect(store.oracleTriggerSourceState(id)?.result).toBeUndefined();
    expect(tab.sql).toBe(draft);
  });

  it("uses the same plan and SQL confirmation for Save and a direct full-definition Run, never the generic query executor", async () => {
    const { store, id, tab } = await open();
    const { useSqlExecutionDangerStore } = await import("@/stores/sqlExecutionDangerStore");
    const danger = useSqlExecutionDangerStore();
    expect(store.oracleTriggerSourceState(id)?.baseline?.metadata.parent?.owner).toBe("Parent");
    const pending = store.executeTabSql(id, tab.sql);
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    expect(danger.pending?.sql).toBe(ddl);
    danger.confirm();
    await pending;
    expect(store.oracleTriggerSourceState(id)?.result?.steps[0]).toMatchObject({ state: "committed", verification: "applied" });
    expect(rpc.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT"))).toHaveLength(1);
    const second = store.runOracleTriggerSourceAction(id);
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    danger.cancel();
    await second;
    expect(rpc.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT"))).toHaveLength(1);
  });

  it("blocks arbitrary/partial SQL on a bound exact trigger tab and leaves its draft intact", async () => {
    const { store, id, tab } = await open();
    await store.executeTabSql(id, "DROP TABLE Parent.T");
    expect(store.oracleTriggerSourceState(id)?.error).toBeTruthy();
    expect(tab.sql).toBe(ddl);
    expect(rpc.executeQuery).not.toHaveBeenCalled();
  });

  it("cancels the source confirmation on tab switch without executing its DDL", async () => {
    const { store, id, tab } = await open();
    const { useSqlExecutionDangerStore } = await import("@/stores/sqlExecutionDangerStore");
    const danger = useSqlExecutionDangerStore();
    const pending = store.runOracleTriggerSourceAction(id);
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    store.createTab("source-trigger", "service", "Other query");
    await expect(pending).resolves.toBe(false);
    expect(danger.pending).toBeUndefined();
    expect(tab.sql).toBe(ddl);
    expect(rpc.executeQuery.mock.calls.every((call) => call[2].startsWith("SELECT"))).toBe(true);
  });

  it("keeps a dirty manual correction through an explicit authority refresh", async () => {
    const { store, id, tab } = await open();
    const draft = `${ddl}\n-- unfinished correction`;
    store.updateSql(id, draft);
    raw.source = `${ddl}\n-- latest server source`;
    expect(store.refreshObjectSourceTab(id)).toBe(true);
    await vi.waitFor(() => expect(tab.sourceLoad).toBeUndefined());
    expect(tab.sql).toBe(draft);
    expect(store.isTabDirty(tab)).toBe(true);
    expect(store.oracleTriggerSourceState(id)?.baseline?.raw.source).toBe(raw.source);
    expect(rpc.executeQuery).not.toHaveBeenCalled();
  });
});
