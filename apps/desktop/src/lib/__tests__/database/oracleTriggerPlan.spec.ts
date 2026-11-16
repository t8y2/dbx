import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, ObjectSource } from "@/types/database";
import type { BackendError } from "@/lib/backend/errorUtils";

const mocks = vi.hoisted(() => ({ source: vi.fn(), query: vi.fn(), objects: vi.fn(), unlockState: vi.fn(), prepareSql: vi.fn(), dropSql: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/backend/api", () => ({
  getObjectSource: mocks.source,
  executeQuery: mocks.query,
  listObjects: mocks.objects,
  prepareOracleTriggerSql: mocks.prepareSql,
  buildDropObjectSql: mocks.dropSql,
  connectionWriteUnlockState: mocks.unlockState,
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  listInstalledAgents: vi.fn().mockResolvedValue([]),
}));

const target = { connectionId: "trigger-plan", database: "service", catalog: "container", owner: " Trigger Owner ", name: ' Tr"ig ', executionSchema: " Execution Owner " };

function source(enabled: boolean): ObjectSource {
  return {
    name: target.name,
    schema: target.owner,
    object_type: "TRIGGER",
    source: "BEGIN :NEW.V := 7; END;",
    editable: false,
    trigger: {
      name: target.name,
      event: "UPDATE",
      timing: "INSTEAD OF",
      enabled,
      valid: false,
      oracle_metadata: {
        contractVersion: 1,
        identityMode: "exact",
        engine: "oceanbase-oracle",
        engineVersion: "4.2.5.7_107",
        owner: target.owner,
        name: target.name,
        objectId: "9007199254740993",
        lastDdlTime: "2026-10-21 08:00:00",
        scope: "VIEW",
        parent: { owner: " Parent Owner ", name: " View ", objectType: "VIEW" },
        definition: { origin: "catalog-body", format: "body", complete: false },
        errors: [{ sequence: 1, line: 3, position: 7, text: "Missing procedure" }],
        reads: { identity: { state: "available" }, scope: { state: "available" }, parent: { state: "available" }, enabled: { state: "available" }, validity: { state: "available" }, definition: { state: "denied" }, errors: { state: "available" } },
      },
    },
  };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.source.mockReset();
  mocks.query.mockReset();
  mocks.prepareSql.mockReset();
  mocks.dropSql.mockReset().mockResolvedValue('DROP TRIGGER " Trigger Owner "." Tr""ig ";');
  mocks.unlockState.mockReset().mockResolvedValue(0);
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
  setActivePinia(createPinia());
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const store = useConnectionStore();
  store.connections = [{ id: target.connectionId, name: "Trigger test", db_type: "oceanbase-oracle", username: " Execution Owner ", database: "service" } as ConnectionConfig];
  store.connectedIds.add(target.connectionId);
  mocks.query.mockResolvedValue({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 });
});

describe("Oracle-family trigger action plans", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])("preserves each trigger execution schema and the legacy statement's captured/default schema (explicit unset=%s)", async (explicitUnset) => {
    const second = { ...target, owner: "Other.Owner", name: "OtherTrigger", executionSchema: "Other.Execution" };
    const gone = new Set<string>();
    const key = (owner: string, name: string) => JSON.stringify([owner, name]);
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    mocks.source.mockImplementation(async (_id, _db, owner, name) => {
      const raw = source(false);
      raw.name = raw.trigger!.name = name;
      raw.schema = raw.trigger!.oracle_metadata!.owner = owner;
      raw.trigger!.oracle_metadata!.name = name;
      raw.trigger!.oracle_metadata!.objectId = gone.has(key(owner, name)) ? null : `${owner}-physical-id`;
      raw.trigger!.oracle_metadata!.reads.identity = { state: gone.has(key(owner, name)) ? "empty" : "available" };
      return raw;
    });
    mocks.dropSql.mockImplementation(async (input) => `DROP TRIGGER ${quote(input.schema)}.${quote(input.name)};`);
    mocks.query.mockImplementation(async (_id, _db, sql) => {
      if (sql.startsWith("SELECT USER")) return { columns: ["SESSION_USER"], rows: [["Login.Owner"]] };
      if (sql.includes("DBA_OBJECTS")) return { columns: ["OWNER", "OBJECT_NAME"], rows: [] };
      if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[" Parent Owner ", " View ", "VIEW", "parent-id"]] };
      for (const item of [target, second]) if (sql === `DROP TRIGGER ${quote(item.owner)}.${quote(item.name)};`) gone.add(key(item.owner, item.name));
      return { columns: [], rows: [] };
    });
    const { prepareOracleTriggerPlan, prepareOracleTriggerDropBatchPlan, executeOracleTriggerDropBatchPlan } = await import("@/lib/database/oracleTriggerPlan");
    const firstPlan = await prepareOracleTriggerPlan({ target, action: "delete" });
    const secondPlan = await prepareOracleTriggerPlan({ target: second, action: "delete" });
    const legacy = { id: "legacy", sql: 'DROP TRIGGER "Legacy.Owner"."Legacy";', ...(explicitUnset ? { executionSchema: undefined } : {}) };
    const plan = prepareOracleTriggerDropBatchPlan({ target, engine: "oceanbase-oracle", entries: [{ id: "first", sql: firstPlan.steps[0].sql, triggerPlan: firstPlan }, legacy, { id: "second", sql: secondPlan.steps[0].sql, triggerPlan: secondPlan }] });
    const result = await executeOracleTriggerDropBatchPlan(plan, { confirmed: true, isCurrent: () => true, timeoutSecs: 0 });
    expect(result.steps.map((step) => step.state)).toEqual(["committed", "committed", "committed"]);
    expect(result.steps[1].elapsedMs).toBeTypeOf("number");
    const writes = mocks.query.mock.calls.filter((call) => !call[2].startsWith("SELECT"));
    expect(writes.map((call) => call[3])).toEqual([target.executionSchema, explicitUnset ? undefined : target.executionSchema, second.executionSchema]);
    expect(writes.every((call) => call[4] === undefined && call[5].catalog === target.catalog)).toBe(true);
    expect(writes.map((call) => call[5].timeoutSecs)).toEqual([0, 0, 0]);
    await expect(executeOracleTriggerDropBatchPlan(plan, { confirmed: true, isCurrent: () => true })).rejects.toThrow(/remaining deletions/i);
    expect(mocks.query.mock.calls.filter((call) => !call[2].startsWith("SELECT"))).toHaveLength(3);
  });

  it.each(["tauri", "http"] as const)("sends catalog through real %s query options, not the execution identifier", async (kind) => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    useConnectionStore().getConfig(target.connectionId)!.query_timeout_secs = 0;
    const envelopes: Record<string, unknown>[] = [];
    let enabled = false;
    mocks.source.mockImplementation(async () => source(enabled));
    const execute = (payload: Record<string, unknown>) => {
      envelopes.push(payload);
      enabled = true;
      return { columns: [], rows: [] };
    };
    mocks.invoke.mockImplementation(async (_command, payload) => execute(payload));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => ({ ok: true, json: async () => execute(JSON.parse(init.body)) })),
    );
    const transport = kind === "tauri" ? await import("@/lib/backend/tauri") : await import("@/lib/backend/http");
    mocks.query.mockImplementation(transport.executeQuery);
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const result = await executeOracleTriggerPlan(await prepareOracleTriggerPlan({ target, action: "enable" }), { confirmed: true });
    expect(result.steps[0]).toMatchObject({ state: "committed", verification: "applied" });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ connectionId: target.connectionId, database: target.database, schema: target.executionSchema, catalog: target.catalog, timeoutSecs: 0 });
    expect(envelopes[0].executionId).toBeUndefined();
  });

  it("rejects a same-name replacement of the identity already shown by the calling form", async () => {
    const changed = source(false);
    changed.trigger!.oracle_metadata!.objectId = "replacement-id";
    mocks.source.mockResolvedValue(changed);
    const { prepareOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    await expect(prepareOracleTriggerPlan({ target, action: "enable", expectedObjectId: "9007199254740993" })).rejects.toThrow(/replaced|identity/i);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("creates the new table before obtaining its real parent ID, then sends the exact confirmed trigger", async () => {
    const triggerName = "new_trigger",
      parentOwner = " Parent Owner ",
      tableName = "NewTable";
    const tableSql = 'CREATE TABLE " Parent Owner "."NewTable" ("ID" NUMBER)';
    const triggerSql = 'CREATE TRIGGER " Trigger Owner "."new_trigger" BEFORE INSERT ON " Parent Owner "."NewTable" DISABLE BEGIN NULL; END;';
    let tableExists = false,
      triggerExists = false;
    mocks.source.mockImplementation(async () => {
      const raw = source(false);
      raw.name = triggerName;
      raw.source = triggerExists ? triggerSql : "";
      raw.trigger!.name = triggerName;
      raw.trigger!.statement = "BEGIN NULL; END;";
      raw.trigger!.valid = true;
      Object.assign(raw.trigger!.oracle_metadata!, {
        name: triggerName,
        objectId: triggerExists ? "created-trigger-id" : null,
        scope: triggerExists ? "TABLE" : "UNKNOWN",
        parent: triggerExists ? { owner: parentOwner, name: tableName, objectType: "TABLE" } : null,
        definition: { origin: "ALL_SOURCE", format: "ddl", complete: triggerExists },
      });
      raw.trigger!.oracle_metadata!.reads.identity = { state: triggerExists ? "available" : "empty" };
      raw.trigger!.oracle_metadata!.reads.definition = { state: triggerExists ? "available" : "empty" };
      return raw;
    });
    mocks.prepareSql.mockImplementation(async (input) => ({ definition: input.source, comparisonSource: input.source, header: { scope: "RELATION", owner: parentOwner, name: tableName, viewOnly: false, pluggable: false }, requiresStateRestore: false }));
    mocks.query.mockImplementation(async (_id, _db, sql) => {
      if (sql.startsWith("SELECT")) {
        if (!tableExists) throw new Error("The parent does not exist before CREATE TABLE");
        return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[parentOwner, tableName, "TABLE", "new-parent-id"]] };
      }
      if (sql === tableSql) tableExists = true;
      if (sql === triggerSql) triggerExists = true;
      return { columns: [], rows: [], affected_rows: 0 };
    });
    const { prepareOracleTriggerStructurePlan } = await import("@/lib/database/oracleTriggerStructurePlan");
    const { executeOracleTriggerStructurePlan } = await import("@/lib/database/oracleTriggerPlan");
    const plan = await prepareOracleTriggerStructurePlan({
      target: { ...target, owner: parentOwner, tableName, parentType: "TABLE", databaseType: "oceanbase-oracle", newTable: true },
      statements: [tableSql, triggerSql],
      operations: [{ draftId: "new", action: "create", owner: target.owner, name: triggerName, statementIndex: 1, statementCount: 1, enabled: false }],
      triggers: [{ id: "new", name: triggerName, timing: "BEFORE", event: "INSERT", statement: "BEGIN NULL; END;", enabled: false, markedForDrop: false, oracleExact: { owner: target.owner, parentType: "TABLE" } }],
    });
    expect(mocks.query).not.toHaveBeenCalled();
    const result = await executeOracleTriggerStructurePlan(plan, { confirmed: true, isCurrent: () => true });
    expect(result.steps.map((step) => step.state)).toEqual(["committed", "committed"]);
    for (const call of mocks.query.mock.calls) {
      expect(call[4]).toBeUndefined();
      expect(call[5]).toMatchObject({ catalog: target.catalog });
    }
    expect(mocks.query.mock.calls.filter((call) => !call[2].startsWith("SELECT")).map((call) => call[2])).toEqual([tableSql, triggerSql]);
    await expect(executeOracleTriggerStructurePlan(plan, { confirmed: true, isCurrent: () => true })).rejects.toThrow(/already attempted/i);
  });

  it.each([true, false])("only permits a lossless structured rename and stops after a rejected CREATE (structured=%s)", async (structured) => {
    const old = source(false);
    old.source = 'CREATE OR REPLACE TRIGGER " Trigger Owner "." Tr""ig " INSTEAD OF UPDATE ON " Parent Owner "." View " BEGIN NULL; END;';
    if (!structured) old.source = old.source.replace(" BEGIN", " FOLLOWS OTHER_TRIGGER BEGIN");
    old.trigger!.statement = "BEGIN NULL; END;";
    old.trigger!.valid = true;
    old.trigger!.oracle_metadata!.definition = { origin: "ALL_SOURCE", format: "ddl", complete: true };
    old.trigger!.oracle_metadata!.reads.definition = { state: "available" };
    let oldExists = true;
    const newName = "NewTrigger",
      createSql = 'CREATE TRIGGER " Trigger Owner "."NewTrigger" INSTEAD OF UPDATE ON " Parent Owner "." View " DISABLE BEGIN NULL; END;',
      dropSql = 'DROP TRIGGER " Trigger Owner "." Tr""ig ";';
    mocks.source.mockImplementation(async (_id, _db, _owner, name) => {
      if (name === target.name && oldExists) return JSON.parse(JSON.stringify(old));
      const absent = source(false);
      absent.name = name;
      absent.source = "";
      absent.trigger!.name = name;
      Object.assign(absent.trigger!.oracle_metadata!, { name, objectId: null });
      absent.trigger!.oracle_metadata!.reads.identity = { state: "empty" };
      return absent;
    });
    mocks.prepareSql.mockImplementation(async (input) => ({ definition: input.source, comparisonSource: input.source, structuredEditable: structured, header: { scope: "RELATION", owner: " Parent Owner ", name: " View ", viewOnly: true, pluggable: false }, requiresStateRestore: false }));
    mocks.dropSql.mockResolvedValue(dropSql);
    mocks.query.mockImplementation(async (_id, _db, sql) => {
      if (sql.startsWith("SELECT USER")) return { columns: ["SESSION_USER"], rows: [[target.owner]] };
      if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[" Parent Owner ", " View ", "VIEW", "parent-id"]] };
      if (sql === dropSql) {
        oldExists = false;
        return { columns: [], rows: [] };
      }
      return {
        columns: [],
        rows: [],
        execution_error: true,
        error: {
          version: 1,
          code: "DBX-JDBC-4001",
          messageKey: "backendErrors.jdbc.sqlFailed",
          messageParams: {},
          source: "jdbc-agent",
          operationOutcome: "unknown",
          detail: "ORA-01031: insufficient privileges",
          origin: { subsystem: "database", adapter: "jdbc-agent" },
          diagnostics: { category: "sql", stage: "execute", vendorCode: 1031 },
        },
      };
    });
    const { prepareOracleTriggerStructurePlan } = await import("@/lib/database/oracleTriggerStructurePlan");
    const { executeOracleTriggerStructurePlan } = await import("@/lib/database/oracleTriggerPlan");
    const preparing = prepareOracleTriggerStructurePlan({
      target: { ...target, owner: " Parent Owner ", tableName: " View ", parentType: "VIEW", databaseType: "oceanbase-oracle", newTable: false },
      statements: [dropSql, createSql, "COMMENT ON TABLE later IS 'not sent'"],
      operations: [
        { draftId: "rename", action: "delete", owner: target.owner, name: target.name, statementIndex: 0, statementCount: 1 },
        { draftId: "rename", action: "create", owner: target.owner, name: newName, statementIndex: 1, statementCount: 1, enabled: false },
      ],
      triggers: [{ id: "rename", name: newName, timing: old.trigger!.timing, event: old.trigger!.event, statement: old.trigger!.statement!, enabled: false, original: old.trigger!, markedForDrop: false, loadedOracleSource: old.source, oracleExact: { owner: target.owner, parentType: "VIEW" } }],
    });
    if (!structured) {
      await expect(preparing).rejects.toThrow("Edit the complete trigger source");
      expect(mocks.query.mock.calls.filter((call) => !call[2].startsWith("SELECT"))).toHaveLength(0);
      return;
    }
    const plan = await preparing;
    const result = await executeOracleTriggerStructurePlan(plan, { confirmed: true, isCurrent: () => true });
    expect(result.steps.map((step) => step.state)).toEqual(["committed", "rejected", "notExecuted"]);
    expect(plan.groups[0].plan?.before.raw.source).toBe(old.source);
    expect(mocks.query.mock.calls.filter((call) => !call[2].startsWith("SELECT")).map((call) => call[2])).toEqual([dropSql, createSql]);
    await expect(executeOracleTriggerStructurePlan(plan, { confirmed: true, isCurrent: () => true })).rejects.toThrow(/already attempted/i);
  });
  it("enables the exact trigger through its own owner without requiring a replaceable source", async () => {
    mocks.source.mockResolvedValueOnce(source(false)).mockResolvedValueOnce(source(false)).mockResolvedValueOnce(source(true));
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const plan = await prepareOracleTriggerPlan({ target, action: "enable" });
    expect(plan.steps.map((step) => step.sql)).toEqual(['ALTER TRIGGER " Trigger Owner "." Tr""ig " ENABLE;']);
    const result = await executeOracleTriggerPlan(plan, { confirmed: true });
    expect(mocks.query).toHaveBeenCalledWith(target.connectionId, "service", 'ALTER TRIGGER " Trigger Owner "." Tr""ig " ENABLE;', " Execution Owner ", undefined, { catalog: "container", timeoutSecs: 60 });
    expect(result.steps[0]).toMatchObject({ state: "committed", verification: "applied" });
    expect(result.snapshot?.raw.trigger).toMatchObject({ enabled: true, valid: false });
    expect(result.snapshot?.metadata.parent).toEqual({ owner: " Parent Owner ", name: " View ", objectType: "VIEW" });
    expect(result.snapshot?.raw.source).toBe("BEGIN :NEW.V := 7; END;");
    expect(result.snapshot?.metadata.errors).toEqual([{ sequence: 1, line: 3, position: 7, text: "Missing procedure" }]);
  });

  it("retains an unknown dispatched write and recovers by read-only verification without replaying it", async () => {
    mocks.source.mockResolvedValueOnce(source(false)).mockResolvedValueOnce(source(false)).mockRejectedValueOnce(new Error("readback disconnected")).mockResolvedValueOnce(source(true)).mockResolvedValueOnce(source(true)).mockResolvedValueOnce(source(true));
    mocks.query.mockRejectedValue(new Error("response lost after dispatch"));
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan, readOracleTriggerSnapshot } = await import("@/lib/database/oracleTriggerPlan");
    const plan = await prepareOracleTriggerPlan({ target, action: "enable" });
    const result = await executeOracleTriggerPlan(plan, { confirmed: true });
    expect(result.steps[0]).toMatchObject({ state: "unknown", verification: "unverified", error: "response lost after dispatch", readbackError: "readback disconnected" });
    expect(Object.isFrozen(plan.before.identity)).toBe(true);
    await expect(executeOracleTriggerPlan(plan, { confirmed: true })).rejects.toThrow();
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const verified = await readOracleTriggerSnapshot(target);
    expect(verified.raw.trigger?.enabled).toBe(true);
    const remaining = await prepareOracleTriggerPlan({ target, action: "enable" });
    expect(remaining.steps).toEqual([]);
    const recovered = await executeOracleTriggerPlan(remaining, { confirmed: true });
    expect(recovered.snapshot?.raw.trigger?.enabled).toBe(true);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    await expect(executeOracleTriggerPlan(plan, { confirmed: true })).rejects.toThrow();
  });

  it("keeps a verified native write committed when the auxiliary list refresh fails", async () => {
    mocks.source.mockResolvedValueOnce(source(false)).mockResolvedValueOnce(source(false)).mockResolvedValueOnce(source(true));
    mocks.objects.mockRejectedValueOnce(new Error("list refresh failed"));
    const api = await import("@/lib/backend/api");
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const plan = await prepareOracleTriggerPlan({ target, action: "enable" });
    const result = await executeOracleTriggerPlan(plan, {
      confirmed: true,
      refresh: async (fixed) => {
        await api.listObjects(fixed.connectionId, fixed.database, fixed.owner, ["TRIGGER"]);
      },
    });
    expect(result.steps[0]).toMatchObject({ state: "committed", verification: "applied" });
    expect(result.refreshError).toBe("list refresh failed");
    expect(mocks.objects).toHaveBeenCalledWith(target.connectionId, "service", " Trigger Owner ", ["TRIGGER"]);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "native permission refusal",
      state: "rejected",
      receipt: "rejected",
      error: {
        version: 1,
        code: "DBX-JDBC-4001",
        messageKey: "backendErrors.jdbc.sqlFailed",
        messageParams: { stage: "execute" },
        source: "jdbc-agent",
        operationOutcome: "unknown",
        origin: { subsystem: "database", adapter: "jdbc-agent" },
        detail: "ORA-01031: insufficient privileges",
        diagnostics: { category: "sql", stage: "execute", sqlState: "42000", vendorCode: 1031 },
      } as BackendError,
    },
    {
      name: "known pre-execution failure",
      state: "notExecuted",
      receipt: "notStarted",
      error: {
        version: 1,
        code: "DBX-JDBC-1001",
        messageKey: "backendErrors.jdbc.connectionFailed",
        messageParams: { stage: "connect" },
        source: "jdbc-agent",
        operationOutcome: "not_started",
        origin: { subsystem: "database", adapter: "jdbc-agent" },
        detail: "Connection could not start",
        diagnostics: { category: "connection", stage: "connect" },
      } as BackendError,
    },
  ])("separates $name from an unknown write", async ({ error, state, receipt }) => {
    mocks.source.mockResolvedValueOnce(source(false)).mockResolvedValueOnce(source(false)).mockResolvedValueOnce(source(false));
    mocks.query.mockResolvedValueOnce({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, execution_error: true, error });
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const plan = await prepareOracleTriggerPlan({ target, action: "enable" });
    const result = await executeOracleTriggerPlan(plan, { confirmed: true });
    expect(result.steps[0]).toMatchObject({ state, verification: "unchanged", receipt, error: error.detail });
    expect(result.snapshot?.raw.trigger?.enabled).toBe(false);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    await expect(executeOracleTriggerPlan(plan, { confirmed: true })).rejects.toThrow();
  });

  it.each([true, false])("does not request write access for an unchanged action, but preserves the guard when currently enabled=%s", async (enabled) => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    useConnectionStore().getConfig(target.connectionId)!.read_only = true;
    mocks.source.mockResolvedValue(source(enabled));
    const { useReadOnlyUnlockStore } = await import("@/stores/readOnlyUnlockStore");
    const unlock = useReadOnlyUnlockStore();
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const plan = await prepareOracleTriggerPlan({ target, action: "enable" });
    let finished = false;
    const pending = executeOracleTriggerPlan(plan, { confirmed: true }).then((result) => {
      finished = true;
      return result;
    });
    await vi.waitFor(() => expect(finished || Boolean(unlock.pending)).toBe(true));
    const requested = unlock.pending;
    if (requested) unlock.cancel();
    const result = await pending;
    expect(Boolean(requested)).toBe(!enabled);
    if (enabled) {
      expect(result.cancelled).not.toBe(true);
      expect(result.snapshot?.raw.trigger?.enabled).toBe(true);
      expect(mocks.unlockState).not.toHaveBeenCalled();
    } else expect(result.cancelled).toBe(true);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("compiles a verified OB trigger without a parent/full source and reports HTTP-success-but-INVALID", async () => {
    const raw = source(true);
    raw.trigger!.oracle_metadata!.scope = "UNKNOWN";
    raw.trigger!.oracle_metadata!.parent = null;
    raw.trigger!.oracle_metadata!.reads.scope = { state: "unavailable" };
    raw.trigger!.oracle_metadata!.reads.parent = { state: "unavailable" };
    mocks.source.mockResolvedValue(raw);
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const plan = await prepareOracleTriggerPlan({ target, action: "compile" });
    expect(plan.steps.map((step) => step.sql)).toEqual(['ALTER TRIGGER " Trigger Owner "." Tr""ig " COMPILE']);
    const result = await executeOracleTriggerPlan(plan, { confirmed: true });
    expect(result.steps[0]).toMatchObject({ state: "committed", verification: "invalid", receipt: "accepted" });
    expect(result.snapshot?.raw.trigger).toMatchObject({ enabled: true, valid: false });
    expect(result.snapshot?.metadata.errors).toEqual([{ sequence: 1, line: 3, position: 7, text: "Missing procedure" }]);
    expect(mocks.query.mock.calls.map((call) => call[2])).toEqual(['ALTER TRIGGER " Trigger Owner "." Tr""ig " COMPILE']);
  });

  it("rejects a same-ID same-second source change inside a q-quoted literal before sending DDL", async () => {
    const before = source(false),
      changed = source(false),
      after = source(true);
    before.source = "BEGIN :NEW.V := q'[first\r\nsecond]'; END;";
    changed.source = "BEGIN :NEW.V := q'[first\nsecond]'; END;";
    after.source = changed.source;
    mocks.source.mockResolvedValueOnce(before).mockResolvedValueOnce(changed).mockResolvedValueOnce(after);
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const plan = await prepareOracleTriggerPlan({ target, action: "enable" });
    await expect(executeOracleTriggerPlan(plan, { confirmed: true })).rejects.toThrow("changed");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("keeps the requested action and execution target fixed while metadata is loading", async () => {
    let release!: (value: ObjectSource) => void;
    mocks.source.mockReturnValueOnce(
      new Promise<ObjectSource>((resolve) => {
        release = resolve;
      }),
    );
    const { prepareOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const input = { target: { ...target }, action: "enable" as "enable" | "disable" };
    const pending = prepareOracleTriggerPlan(input);
    input.action = "disable";
    input.target.owner = "Changed Owner";
    input.target.executionSchema = "Changed Execution";
    release(source(false));
    const plan = await pending;
    expect(plan.action).toBe("enable");
    expect(plan.target).toEqual(target);
    expect(plan.steps.map((step) => step.sql)).toEqual(['ALTER TRIGGER " Trigger Owner "." Tr""ig " ENABLE;']);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("reads DM's disabled INVALID state after a native compilation error and never sends ENABLE", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    useConnectionStore().getConfig(target.connectionId)!.db_type = "jdbc";
    const before = source(true),
      after = source(false);
    before.trigger!.valid = true;
    before.trigger!.oracle_metadata!.errors = [];
    for (const raw of [before, after]) {
      raw.trigger!.oracle_metadata!.engine = "dm";
      raw.trigger!.oracle_metadata!.engineVersion = "8.1.5";
    }
    after.trigger!.oracle_metadata!.lastDdlTime = "2026-10-21 08:00:01";
    mocks.source.mockResolvedValueOnce(before).mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const error: BackendError = {
      version: 1,
      code: "DBX-JDBC-4001",
      messageKey: "backendErrors.jdbc.sqlFailed",
      messageParams: { stage: "execute" },
      source: "jdbc-agent",
      operationOutcome: "unknown",
      origin: { subsystem: "database", adapter: "jdbc-agent" },
      detail: "Trigger compilation failed",
      diagnostics: { category: "sql", stage: "execute", sqlState: "42000", vendorCode: -2007 },
    };
    mocks.query.mockResolvedValueOnce({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, execution_error: true, error });
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const plan = await prepareOracleTriggerPlan({ target, action: "compile" });
    const result = await executeOracleTriggerPlan(plan, { confirmed: true });
    expect(result.steps[0]).toMatchObject({ verification: "invalid", error: "Trigger compilation failed" });
    expect(result.snapshot?.raw.trigger).toMatchObject({ enabled: false, valid: false });
    expect(result.snapshot?.metadata.errors?.[0]).toMatchObject({ line: 3, position: 7, text: "Missing procedure" });
    expect(mocks.query.mock.calls.map((call) => call[2])).toEqual(['ALTER TRIGGER " Trigger Owner "." Tr""ig " COMPILE']);
  });

  it("creates only a plain CREATE on the verified independent parent and reports the actual INVALID object", async () => {
    const absent = source(false),
      created = source(false);
    absent.source = "";
    absent.trigger!.oracle_metadata!.objectId = null;
    absent.trigger!.oracle_metadata!.reads.identity = { state: "empty" };
    const definition = 'CREATE TRIGGER " Trigger Owner "." Tr""ig " INSTEAD OF UPDATE ON " Parent Owner "." View " DISABLE BEGIN NULL; END;';
    created.source = definition;
    created.trigger!.oracle_metadata!.definition = { origin: "DBMS_METADATA", format: "ddl", complete: true };
    created.trigger!.oracle_metadata!.reads.definition = { state: "available" };
    mocks.prepareSql.mockResolvedValue({ definition, comparisonSource: definition, header: { scope: "RELATION", owner: " Parent Owner ", name: " View ", viewOnly: true, pluggable: false }, inlineEnabled: false, requiresStateRestore: false });
    mocks.source.mockResolvedValueOnce(absent).mockResolvedValueOnce(absent).mockResolvedValueOnce(created);
    mocks.query.mockImplementation(async (_id, _db, sql) => (sql.startsWith("SELECT") ? { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[" Parent Owner ", " View ", "VIEW", "9007199254740995"]] } : { columns: [], rows: [] }));
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const plan = await prepareOracleTriggerPlan({ target, action: "create", source: definition, enabled: false, selection: { scope: "VIEW", owner: " Parent Owner ", name: " View " } });
    expect(plan.expectedAfter?.binding).toEqual({ scope: "VIEW", owner: " Parent Owner ", name: " View ", pluggable: false });
    expect(plan.steps.map((step) => step.sql)).toEqual([definition]);
    const result = await executeOracleTriggerPlan(plan, { confirmed: true });
    expect(result.steps[0]).toMatchObject({ state: "committed", verification: "invalid" });
    expect(mocks.query.mock.calls.filter((call) => !call[2].startsWith("SELECT")).map((call) => call[2])).toEqual([definition]);
  });

  it("blocks replacement against a different loaded source baseline and a parent rebuilt after confirmation", async () => {
    const before = source(false);
    before.source = 'CREATE TRIGGER " Trigger Owner "." Tr""ig " INSTEAD OF UPDATE ON " Parent Owner "." View " DISABLE BEGIN NULL; END;';
    before.trigger!.oracle_metadata!.definition = { origin: "DBMS_METADATA", format: "ddl", complete: true };
    before.trigger!.oracle_metadata!.reads.definition = { state: "available" };
    mocks.prepareSql.mockResolvedValue({ definition: before.source, comparisonSource: before.source, header: { scope: "RELATION", owner: " Parent Owner ", name: " View ", viewOnly: true, pluggable: false }, requiresStateRestore: false });
    mocks.source.mockResolvedValue(before);
    let parentReads = 0;
    mocks.query.mockImplementation(async () => ({ columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[" Parent Owner ", " View ", "VIEW", ++parentReads === 1 ? "parent-before" : "parent-rebuilt"]] }));
    const { readOracleTriggerSnapshot, prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const baseline = await readOracleTriggerSnapshot(target);
    const plan = await prepareOracleTriggerPlan({ target, action: "replace", baseline, source: before.source });
    await expect(executeOracleTriggerPlan(plan, { confirmed: true })).rejects.toThrow(/owning object|parent|scope/i);
    expect(mocks.query.mock.calls.every((call) => call[2].startsWith("SELECT"))).toBe(true);
    const changed = JSON.parse(JSON.stringify(before));
    changed.source += " -- other writer";
    mocks.source.mockResolvedValue(changed);
    await expect(prepareOracleTriggerPlan({ target, action: "replace", baseline, source: before.source })).rejects.toThrow(/changed|baseline/i);
  });

  it("does not treat a cross-owner empty ALL_* read as a verified deletion when the global dictionary is denied", async () => {
    const absent = source(false);
    absent.source = "";
    absent.trigger!.oracle_metadata!.objectId = null;
    absent.trigger!.oracle_metadata!.reads.identity = { state: "empty" };
    mocks.source.mockResolvedValueOnce(source(false)).mockResolvedValueOnce(source(false)).mockResolvedValueOnce(absent);
    mocks.query.mockImplementation(async (_id, _db, sql) => {
      if (sql.includes("DBA_OBJECTS")) throw new Error("global dictionary denied");
      if (sql.includes("SELECT USER")) return { columns: ["SESSION_USER"], rows: [[" Execution Owner "]] };
      if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[" Parent Owner ", " View ", "VIEW", "parent-before"]] };
      return { columns: [], rows: [] };
    });
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const plan = await prepareOracleTriggerPlan({ target, action: "delete" });
    const result = await executeOracleTriggerPlan(plan, { confirmed: true });
    expect(result.steps[0]).toMatchObject({ state: "unknown", verification: "unverified", receipt: "accepted" });
    expect(result.steps[0].readbackError).toContain("global dictionary denied");
    expect(mocks.query.mock.calls.filter((call) => !call[2].startsWith("SELECT")).map((call) => call[2])).toEqual(['DROP TRIGGER " Trigger Owner "." Tr""ig ";']);
    await expect(executeOracleTriggerPlan(plan, { confirmed: true })).rejects.toThrow();
  });

  it("keeps DM's committed definition and stops its separately previewed disabled-state restoration after a lost receipt", async () => {
    const absent = source(false),
      created = source(true);
    const definition = 'CREATE TRIGGER " Trigger Owner "." Tr""ig " INSTEAD OF UPDATE ON " Parent Owner "." View " BEGIN NULL; END;';
    for (const raw of [absent, created]) {
      raw.trigger!.oracle_metadata!.engine = "dm";
      raw.trigger!.oracle_metadata!.engineVersion = "8.1.5";
    }
    absent.source = "";
    absent.trigger!.oracle_metadata!.objectId = null;
    absent.trigger!.oracle_metadata!.reads.identity = { state: "empty" };
    created.source = definition;
    created.trigger!.valid = true;
    created.trigger!.oracle_metadata!.definition = { origin: "DBMS_METADATA", format: "ddl", complete: true };
    created.trigger!.oracle_metadata!.reads.definition = { state: "available" };
    mocks.source.mockResolvedValueOnce(absent).mockResolvedValueOnce(absent).mockResolvedValueOnce(created);
    mocks.prepareSql.mockResolvedValue({ definition, comparisonSource: definition, header: { scope: "RELATION", owner: " Parent Owner ", name: " View ", viewOnly: true, pluggable: false }, requiresStateRestore: true });
    mocks.query.mockImplementation(async (_id, _db, sql) => {
      if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[" Parent Owner ", " View ", "VIEW", "parent-before"]] };
      throw new Error("write response lost");
    });
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const plan = await prepareOracleTriggerPlan({ target, action: "create", source: definition, enabled: false, selection: { scope: "VIEW", owner: " Parent Owner ", name: " View " } });
    expect(plan.steps.map((step) => step.action)).toEqual(["create", "disable"]);
    const result = await executeOracleTriggerPlan(plan, { confirmed: true });
    expect(result.steps.map(({ state, verification }) => ({ state, verification }))).toEqual([
      { state: "unknown", verification: "applied" },
      { state: "notExecuted", verification: "unverified" },
    ]);
    expect(result.snapshot?.raw.trigger?.enabled).toBe(true);
    expect(mocks.query.mock.calls.filter((call) => !call[2].startsWith("SELECT")).map((call) => call[2])).toEqual([definition]);
    await expect(executeOracleTriggerPlan(plan, { confirmed: true })).rejects.toThrow();
  });

  it("verifies a deletion of the actual session user's trigger without requiring DBA_OBJECTS and leaves the parent intact", async () => {
    const absent = source(false);
    absent.source = "";
    absent.trigger!.oracle_metadata!.objectId = null;
    absent.trigger!.oracle_metadata!.reads.identity = { state: "empty" };
    mocks.source.mockResolvedValueOnce(source(false)).mockResolvedValueOnce(source(false)).mockResolvedValueOnce(absent);
    mocks.query.mockImplementation(async (_id, _db, sql) => {
      if (sql.includes("SELECT USER")) return { columns: ["SESSION_USER"], rows: [[target.owner]] };
      if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[" Parent Owner ", " View ", "VIEW", "parent-before"]] };
      return { columns: [], rows: [] };
    });
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const result = await executeOracleTriggerPlan(await prepareOracleTriggerPlan({ target, action: "delete" }), { confirmed: true });
    expect(result.steps[0]).toMatchObject({ state: "committed", verification: "deleted" });
    expect(mocks.query.mock.calls.some((call) => call[2].includes("DBA_OBJECTS"))).toBe(false);
    expect(mocks.query.mock.calls.filter((call) => !call[2].startsWith("SELECT")).map((call) => call[2])).toEqual(['DROP TRIGGER " Trigger Owner "." Tr""ig ";']);
  });

  it("keeps a post-dispatch result on its fixed target when only the UI moves away", async () => {
    let current = true;
    mocks.source.mockResolvedValueOnce(source(false)).mockResolvedValueOnce(source(false)).mockResolvedValueOnce(source(true));
    mocks.query.mockImplementationOnce(async () => {
      current = false;
      return { columns: [], rows: [] };
    });
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const result = await executeOracleTriggerPlan(await prepareOracleTriggerPlan({ target, action: "enable" }), { confirmed: true, isCurrent: () => current });
    expect(result.steps[0]).toMatchObject({ state: "committed", verification: "applied" });
    expect(result.snapshot?.target).toEqual(target);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("retires only the real parent's trigger facets after a write, keeping columns and another catalog warm", async () => {
    const { loadObjectMetadataFacet } = await import("@/lib/metadata/objectMetadataCache");
    const parent = { connectionId: target.connectionId, database: target.database, catalog: target.catalog, schema: " Parent Owner ", tableName: " View ", objectType: "VIEW" as const };
    await loadObjectMetadataFacet(parent, "columns", async () => ["column-keep"]);
    await loadObjectMetadataFacet(parent, "triggers", async () => ["legacy-old"]);
    await loadObjectMetadataFacet({ ...parent, oracleTriggerContract: 1 }, "triggers", async () => ["exact-old"]);
    await loadObjectMetadataFacet({ ...parent, exactIdentity: true, oracleTriggerContract: 1 }, "triggers", async () => ["identity-old"]);
    await loadObjectMetadataFacet({ ...parent, catalog: "another-catalog" }, "triggers", async () => ["catalog-keep"]);
    mocks.source.mockResolvedValueOnce(source(false)).mockResolvedValueOnce(source(false)).mockResolvedValueOnce(source(true));
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    await executeOracleTriggerPlan(await prepareOracleTriggerPlan({ target, action: "enable" }), { confirmed: true });
    expect((await loadObjectMetadataFacet(parent, "triggers", async () => ["legacy-new"])).value).toEqual(["legacy-new"]);
    expect((await loadObjectMetadataFacet({ ...parent, oracleTriggerContract: 1 }, "triggers", async () => ["exact-new"])).value).toEqual(["exact-new"]);
    expect((await loadObjectMetadataFacet({ ...parent, exactIdentity: true, oracleTriggerContract: 1 }, "triggers", async () => ["identity-new"])).value).toEqual(["identity-new"]);
    expect((await loadObjectMetadataFacet(parent, "columns", async () => ["incorrect-column-reload"])).value).toEqual(["column-keep"]);
    expect((await loadObjectMetadataFacet({ ...parent, catalog: "another-catalog" }, "triggers", async () => ["incorrect-catalog-reload"])).value).toEqual(["catalog-keep"]);
  });

  it("does not report an enable as verified when a known complete body changed during execution", async () => {
    const before = source(false),
      after = source(true);
    for (const raw of [before, after]) {
      raw.trigger!.oracle_metadata!.definition = { origin: "DBMS_METADATA", format: "ddl", complete: true };
      raw.trigger!.oracle_metadata!.reads.definition = { state: "available" };
    }
    before.source = 'CREATE TRIGGER " Trigger Owner "." Tr""ig " INSTEAD OF UPDATE ON " Parent Owner "." View " BEGIN NULL; END;';
    after.source = before.source.replace("NULL;", "other_procedure;");
    mocks.source.mockResolvedValueOnce(before).mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    mocks.prepareSql.mockImplementation(async (input) => ({ definition: input.source, comparisonSource: input.source, header: { scope: "RELATION", owner: " Parent Owner ", name: " View ", viewOnly: true, pluggable: false }, requiresStateRestore: false }));
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const result = await executeOracleTriggerPlan(await prepareOracleTriggerPlan({ target, action: "enable" }), { confirmed: true });
    expect(result.steps[0]).toMatchObject({ state: "unknown", verification: "mismatch", receipt: "accepted" });
    expect(result.snapshot?.raw.trigger?.enabled).toBe(true);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it.each(["enable", "replace"] as const)("rechecks action-specific read authority after confirmation for %s", async (action) => {
    const before = source(false);
    before.source = 'CREATE TRIGGER " Trigger Owner "." Tr""ig " INSTEAD OF UPDATE ON " Parent Owner "." View " DISABLE BEGIN NULL; END;';
    before.trigger!.oracle_metadata!.definition = { origin: "DBMS_METADATA", format: "ddl", complete: true };
    before.trigger!.oracle_metadata!.reads.definition = { state: "available" };
    const latest: ObjectSource = JSON.parse(JSON.stringify(before));
    if (action === "replace") {
      latest.trigger!.oracle_metadata!.definition!.complete = false;
      latest.trigger!.oracle_metadata!.reads.definition = { state: "denied" };
    } else latest.trigger!.oracle_metadata!.reads.scope = { state: "unavailable" };
    mocks.prepareSql.mockImplementation(async (input) => ({ definition: input.source, comparisonSource: input.source, header: { scope: "RELATION", owner: " Parent Owner ", name: " View ", viewOnly: true, pluggable: false }, requiresStateRestore: false }));
    mocks.query.mockImplementation(async () => ({ columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[" Parent Owner ", " View ", "VIEW", "parent-id"]] }));
    mocks.source.mockResolvedValueOnce(before);
    const { prepareOracleTriggerPlan, readOracleTriggerSnapshot, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const baseline = action === "replace" ? await readOracleTriggerSnapshot(target) : undefined;
    if (baseline) mocks.source.mockResolvedValueOnce(before);
    const plan = await prepareOracleTriggerPlan({ target, action, ...(baseline ? { baseline, source: before.source } : {}) });
    mocks.source.mockResolvedValue(latest);
    await expect(executeOracleTriggerPlan(plan, { confirmed: true })).rejects.toThrow(/complete|scope|unavailable/i);
    expect(mocks.query.mock.calls.every((call) => call[2].startsWith("SELECT"))).toBe(true);
  });

  it("verifies a plain CREATE against OceanBase's CREATE OR REPLACE export wrapper without changing its body", async () => {
    const absent = source(false),
      created = source(true);
    absent.source = "";
    absent.trigger!.oracle_metadata!.objectId = null;
    absent.trigger!.oracle_metadata!.reads.identity = { state: "empty" };
    const tail = ' " Trigger Owner "." Tr""ig " INSTEAD OF UPDATE ON " Parent Owner "." View " ENABLE\nBEGIN NULL; END;';
    const definition = `CREATE TRIGGER${tail}`,
      exported = `CREATE OR REPLACE TRIGGER${tail}`;
    created.source = `${exported}\nALTER TRIGGER " Trigger Owner "." Tr""ig " ENABLE`;
    created.trigger!.valid = true;
    created.trigger!.oracle_metadata!.definition = { origin: "DBMS_METADATA", format: "ddl", complete: true };
    created.trigger!.oracle_metadata!.reads.definition = { state: "available" };
    mocks.prepareSql.mockImplementation(async (input) => ({
      definition: input.source === created.source ? exported : input.source === exported && input.purpose === "create" ? `CREATE   TRIGGER${tail}` : definition,
      comparisonSource: exported,
      header: { scope: "RELATION", owner: " Parent Owner ", name: " View ", viewOnly: true, pluggable: false },
      requiresStateRestore: false,
    }));
    mocks.source.mockResolvedValueOnce(absent).mockResolvedValueOnce(absent).mockResolvedValueOnce(created);
    mocks.query.mockImplementation(async (_id, _db, sql) => (sql.startsWith("SELECT") ? { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[" Parent Owner ", " View ", "VIEW", "parent-id"]] } : { columns: [], rows: [] }));
    const { prepareOracleTriggerPlan, executeOracleTriggerPlan } = await import("@/lib/database/oracleTriggerPlan");
    const result = await executeOracleTriggerPlan(await prepareOracleTriggerPlan({ target, action: "create", source: definition, selection: { scope: "VIEW", owner: " Parent Owner ", name: " View " } }), { confirmed: true });
    expect(result.steps[0]).toMatchObject({ state: "committed", verification: "applied" });
    expect(mocks.query.mock.calls.filter((call) => !call[2].startsWith("SELECT")).map((call) => call[2])).toEqual([definition]);
  });
});
