import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const target = { connectionId: "connection 1", database: "Db/Exact", owner: "MiXeD O'wner", name: "Edit' Type (v1)" };
const knownObjects = [{ owner: target.owner, name: "Removed Dependency", objectType: "TYPE" }];
const payload = {
  target,
  visibilityScope: "current-user-visible-dictionaries",
  details: null,
  detailsRead: { state: "unavailable", reason: "No permission" },
  dependencies: [],
  dependenciesRead: { state: "incomplete", reason: "Result was truncated" },
  objects: [{ owner: target.owner, name: "Removed Dependency", objectType: "TYPE", exists: false, objectId: null, status: null }],
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("Oracle-family TYPE management transports", () => {
  it.each([undefined, { cancel: false }, { cancel: false, typeRecovery: { executionId: "type-step-1", planId: "plan", stepId: "step", connectionId: target.connectionId, database: target.database, schema: target.owner, sql: "approved SQL" } }])(
    "preserves cancellation defaults and forwards TYPE wait-only options over both transports: %j",
    async (options) => {
      const response = { requested: false, terminal: true, databaseTerminal: true };
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => response });
      vi.stubGlobal("fetch", fetchMock);
      mocks.invoke.mockResolvedValue(response);
      const http = await import("@/lib/backend/http");
      const tauri = await import("@/lib/backend/tauri");
      await expect(http.cancelConditionalUpdate("type-step-1", options)).resolves.toEqual(response);
      await expect(tauri.cancelConditionalUpdate("type-step-1", options)).resolves.toEqual(response);
      expect(fetchMock).toHaveBeenCalledWith("/api/query/cancel-conditional-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executionId: "type-step-1", ...options }) });
      expect(mocks.invoke).toHaveBeenCalledWith("cancel_conditional_update", { executionId: "type-step-1", ...options });
    },
  );

  it.each([undefined, { typeRecovery: { planId: "plan", stepId: "step" } }])("forwards opt-in TYPE execution context without changing ordinary calls: %j", async (options) => {
    const response = { columns: [], rows: [], affected_rows: 0 };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => response });
    vi.stubGlobal("fetch", fetchMock);
    mocks.invoke.mockResolvedValue(response);
    const http = await import("@/lib/backend/http");
    const tauri = await import("@/lib/backend/tauri");
    await expect(http.executeConditionalUpdate(target.connectionId, target.database, "approved SQL", target.owner, "type-step-1", options)).resolves.toEqual(response);
    await expect(tauri.executeConditionalUpdate(target.connectionId, target.database, "approved SQL", target.owner, "type-step-1", options)).resolves.toEqual(response);
    const input = { connectionId: target.connectionId, database: target.database, sql: "approved SQL", schema: target.owner, executionId: "type-step-1", ...options };
    expect(fetchMock).toHaveBeenCalledWith("/api/query/execute-conditional-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    expect(mocks.invoke).toHaveBeenCalledWith("execute_conditional_update", input);
  });

  it("uses the same read-only native evolution preview and recovery manifest over both transports", async () => {
    const response = { target, sourceBefore: "original definition", sourceAfter: "approved definition", statements: ["native preview"], metadata: "unchanged targets", phase: 1 };
    const input = { target, sourceBefore: response.sourceBefore, sourceAfter: response.sourceAfter, manifest: response };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => response });
    vi.stubGlobal("fetch", fetchMock);
    mocks.invoke.mockResolvedValue(response);
    const http = await import("@/lib/backend/http");
    const tauri = await import("@/lib/backend/tauri");
    await expect(http.prepareOracleTypeEvolution(input)).resolves.toEqual(response);
    await expect(tauri.prepareOracleTypeEvolution(input)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith("/api/schema/oracle-type-evolution", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    expect(mocks.invoke).toHaveBeenCalledWith("prepare_oracle_type_evolution", { input });
  });
  it.each(["describe", "register", "verify", "validate_insert"] as const)("uses the same bounded data %s contract over both transports", async (action) => {
    const response = { relation: null, manifest: null, insertSql: null };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => response });
    vi.stubGlobal("fetch", fetchMock);
    mocks.invoke.mockResolvedValue(response);
    const input = { target, action, relation: { owner: target.owner, name: "Permanent' Table" }, sql: "fixture draft" };
    const http = await import("@/lib/backend/http");
    const tauri = await import("@/lib/backend/tauri");
    await expect(http.verifyOracleTypeData(input)).resolves.toEqual(response);
    await expect(tauri.verifyOracleTypeData(input)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith("/api/schema/oracle-type-data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    expect(mocks.invoke).toHaveBeenCalledWith("verify_oracle_type_data", { input });
  });
  it("preserves exact names and independent failed sections over HTTP GET", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload });
    vi.stubGlobal("fetch", fetchMock);
    const http = await import("@/lib/backend/http");
    await expect(http.getOracleTypeManagementSnapshot(target.connectionId, target.database, target.owner, target.name)).resolves.toEqual(payload);
    const url = new URL(fetchMock.mock.calls[0][0], "http://fixture");
    expect(url.pathname).toBe("/api/schema/oracle-type-management-snapshot");
    expect(Object.fromEntries(url.searchParams)).toEqual({ connection_id: target.connectionId, database: target.database, schema: target.owner, table: target.name });
  });

  it("posts known identities so recovery can inspect objects after their edges disappear", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload });
    vi.stubGlobal("fetch", fetchMock);
    const http = await import("@/lib/backend/http");
    await expect(http.getOracleTypeManagementSnapshot(target.connectionId, target.database, target.owner, target.name, knownObjects)).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("/api/schema/oracle-type-management-snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, knownObjects }),
    });
  });

  it("passes the same recovery identity and read state through Tauri", async () => {
    mocks.invoke.mockResolvedValue(payload);
    const tauri = await import("@/lib/backend/tauri");
    await expect(tauri.getOracleTypeManagementSnapshot(target.connectionId, target.database, target.owner, target.name, knownObjects)).resolves.toEqual(payload);
    expect(mocks.invoke).toHaveBeenCalledWith("get_oracle_type_management_snapshot", { ...target, knownObjects });
  });

  it("does not turn a failed snapshot request into an empty successful snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Offline")));
    const http = await import("@/lib/backend/http");
    await expect(http.getOracleTypeManagementSnapshot(target.connectionId, target.database, target.owner, target.name)).rejects.toThrow("Offline");
  });

  it.each(["save_spec", "save_body", "drop_spec", "drop_body", "grant_execute", "grant_privilege", "rebuild_source", "compile_spec"] as const)("previews %s through the SQL builder rather than the execution route", async (operation) => {
    const response = { statements: ["fixture preview"] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => response });
    vi.stubGlobal("fetch", fetchMock);
    mocks.invoke.mockResolvedValue(response);
    const http = await import("@/lib/backend/http");
    const tauri = await import("@/lib/backend/tauri");
    const input = { databaseType: "oceanbase-oracle" as const, operation, owner: target.owner, name: target.name, source: "fixture source", grantable: true, objectType: "FUNCTION" as const, privilege: "DEBUG" };
    await expect(http.buildOracleTypeManagementSql(input)).resolves.toEqual(response);
    await expect(tauri.buildOracleTypeManagementSql(input)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith("/api/query/build-oracle-type-management-sql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(mocks.invoke).toHaveBeenCalledWith("build_oracle_type_management_sql", { input });
  });
});
