import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { BackendErrorException } from "@/lib/backend/errorUtils";
import {
  executeOracleTypeManagement,
  OracleTypeManagementFailure,
  prepareOracleTypeManagement,
  restoreOracleTypeManagementDraft,
  typeManagementObjectKey,
  typeManagementSnapshotIdentity,
  type OracleTypeManagementDraft,
  type TypeManagementObjectDraft,
  type TypeManagementTarget,
} from "@/lib/table/oracleTypeManagement";
import type { OracleTypeManagementDependency, OracleTypeManagementObject, OracleTypeManagementSnapshot, OracleTypeManagementSqlInput } from "@/types/database";

vi.mock("@/lib/backend/api", () => ({ getOracleTypeManagementSnapshot: vi.fn(), buildOracleTypeManagementSql: vi.fn(), executeConditionalUpdate: vi.fn(), cancelConditionalUpdate: vi.fn() }));

const target: TypeManagementTarget = { connectionId: "type-manager-test", database: "db", databaseType: "oceanbase-oracle", owner: "APP", name: "ROOT" };
const available = { state: "available" as const };
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const key = (name: string, objectType = "TYPE", owner = "APP") => ({ owner, name, objectType });
const identity = (name: string, objectType = "TYPE", owner = "APP") => typeManagementObjectKey(key(name, objectType, owner));
const originalRoot = 'CREATE OR REPLACE TYPE "APP"."ROOT" AS OBJECT (ID NUMBER);';
const changedRoot = 'CREATE OR REPLACE TYPE "APP"."ROOT" AS OBJECT (ID NUMBER, LABEL VARCHAR2(40));';
const body = 'CREATE OR REPLACE TYPE BODY "APP"."ROOT" AS MEMBER FUNCTION GET_ID RETURN NUMBER AS BEGIN RETURN SELF.ID; END; END;';
let objects: Map<string, OracleTypeManagementObject>;
let edges: OracleTypeManagementDependency[];
let statements: Map<string, OracleTypeManagementSqlInput>;
let fault: ((input: OracleTypeManagementSqlInput) => "reject" | "invalid" | "network-before" | "network-after" | undefined) | undefined;
let snapshotFault: ((snapshot: OracleTypeManagementSnapshot) => void) | undefined;
let requests: string[];

function object(name: string, objectType: string, source: string, objectId: string): OracleTypeManagementObject {
  return { ...key(name, objectType), exists: true, objectId, status: "VALID", statusRead: available, source, sourceRead: available, sourceFingerprint: source, errors: [], errorsRead: available, directPrivileges: [], privilegesRead: objectType === "TYPE" ? available : { state: "unsupported" } };
}

function edge(name: string, type: string, referencedName: string, referencedType = "TYPE"): OracleTypeManagementDependency {
  return { ...key(name, type), referencedOwner: "APP", referencedName, referencedType, referencedLink: null };
}

function snapshot(known: Array<{ owner: string; name: string; objectType: string }> = []): OracleTypeManagementSnapshot {
  const states = [...objects.values()].map(json);
  for (const item of [key("ROOT"), key("ROOT", "TYPE BODY"), ...known]) {
    if (!states.some((candidate) => typeManagementObjectKey(candidate) === typeManagementObjectKey(item)))
      states.push({
        ...item,
        exists: false,
        objectId: null,
        status: null,
        statusRead: available,
        source: null,
        sourceRead: available,
        sourceFingerprint: null,
        errors: [],
        errorsRead: available,
        directPrivileges: [],
        privilegesRead: item.objectType === "TYPE" ? available : { state: "unsupported" },
      });
  }
  const value: OracleTypeManagementSnapshot = {
    target: { connectionId: target.connectionId, database: target.database, owner: target.owner, name: target.name },
    visibilityScope: "current-user-visible-dictionaries",
    actingUser: "APP",
    actingUserRead: available,
    detailsRead: available,
    typeSource: objects.get(identity("ROOT"))?.source,
    typeSourceRead: available,
    bodySource: objects.get(identity("ROOT", "TYPE BODY"))?.source,
    bodySourceRead: available,
    objects: states,
    dependencies: edges.filter((item) => objects.has(typeManagementObjectKey(item)) && objects.has(identity(item.referencedName, item.referencedType))).map(json),
    dependenciesRead: available,
    persistentReferences: [],
    persistentReferencesRead: available,
    directPrivileges: objects.get(identity("ROOT"))?.directPrivileges ?? [],
    privilegesRead: available,
  };
  snapshotFault?.(value);
  return value;
}

function draft(name = "ROOT", source = changedRoot, objectType = "TYPE"): TypeManagementObjectDraft {
  return { ...key(name, objectType), source };
}

function isolateRoot() {
  for (const [id, item] of objects) if (item.name !== "ROOT") objects.delete(id);
  edges = edges.filter((item) => item.name === "ROOT");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.cancelConditionalUpdate).mockResolvedValue({ requested: false, terminal: true, databaseTerminal: true });
  requests = [];
  statements = new Map();
  fault = undefined;
  snapshotFault = undefined;
  objects = new Map([
    [identity("ROOT"), object("ROOT", "TYPE", originalRoot, "9007199254740993")],
    [identity("ROOT", "TYPE BODY"), object("ROOT", "TYPE BODY", body, "2")],
    [identity("COLL"), object("COLL", "TYPE", 'CREATE OR REPLACE TYPE "APP"."COLL" AS TABLE OF "APP"."ROOT";', "3")],
    [identity("DEEP"), object("DEEP", "TYPE", 'CREATE OR REPLACE TYPE "APP"."DEEP" AS TABLE OF "APP"."COLL";', "4")],
    [identity("PROC", "PROCEDURE"), object("PROC", "PROCEDURE", 'CREATE OR REPLACE PROCEDURE "APP"."PROC" AS X "APP"."COLL"; BEGIN NULL; END;', "5")],
    [identity("FN", "FUNCTION"), object("FN", "FUNCTION", 'CREATE OR REPLACE FUNCTION "APP"."FN" RETURN NUMBER AS X "APP"."ROOT"; BEGIN RETURN 1; END;', "6")],
  ]);
  objects.get(identity("COLL"))!.directPrivileges = [{ grantor: "APP", grantee: "OTHER", privilege: "EXECUTE", grantable: true, hierarchy: false }];
  edges = [edge("ROOT", "TYPE BODY", "ROOT"), edge("COLL", "TYPE", "ROOT"), edge("DEEP", "TYPE", "COLL"), edge("PROC", "PROCEDURE", "COLL"), edge("FN", "FUNCTION", "ROOT")];
  vi.mocked(api.getOracleTypeManagementSnapshot).mockImplementation(async (_connection, _database, _owner, _name, known) => snapshot(known));
  vi.mocked(api.buildOracleTypeManagementSql).mockImplementation(async (input) => {
    // External builder transport; declaration/tokenizer correctness is tested in dbx-sql-core.
    if (input.source?.includes("BAD_DECLARATION")) throw new Error("Wrong declaration");
    const sql =
      input.source ?? `${input.operation === "drop_body" ? "DROP TYPE BODY" : input.operation === "drop_spec" ? "DROP TYPE" : `GRANT ${input.privilege ?? "EXECUTE"}`} "${input.owner}"."${input.name}"${input.grantee ? ` TO "${input.grantee}"${input.grantable ? " WITH GRANT OPTION" : ""}` : ""};`;
    statements.set(sql, json(input));
    return { statements: [sql], sourceFingerprint: input.source };
  });
  vi.mocked(api.executeConditionalUpdate).mockImplementation(async (_connection, _database, sql) => {
    requests.push(sql);
    const input = statements.get(sql)!;
    if (!input) throw new Error("Unexpected SQL");
    const failure = fault?.(input);
    if (failure === "network-before") throw new Error("Network response is unknown");
    if (failure === "reject") return { execution_error: true, error: "Rejected by database", messages: [], rows: [] } as never;
    const kind = input.objectType?.replaceAll("_", " ") ?? (input.operation === "save_body" || input.operation === "drop_body" ? "TYPE BODY" : "TYPE");
    const objectKey = identity(input.name, kind, input.owner);
    if (input.operation === "drop_spec" || input.operation === "drop_body") {
      objects.delete(objectKey);
      if (kind === "TYPE") objects.delete(identity(input.name, "TYPE BODY", input.owner));
    } else if (input.operation === "grant_privilege") {
      const actual = objects.get(objectKey)!;
      const grant = { grantor: input.owner, grantee: input.grantee!, privilege: input.privilege!, grantable: input.grantable!, hierarchy: false };
      if (!actual.directPrivileges.some((item) => JSON.stringify(item) === JSON.stringify(grant))) actual.directPrivileges.push(grant);
    } else if (input.operation === "compile_trigger") {
      objects.get(objectKey)!.status = failure === "invalid" ? "INVALID" : "VALID";
    } else {
      const old = objects.get(objectKey);
      const actual = { ...object(input.name, kind, input.source!, old?.objectId ?? `new-${input.name}`), owner: input.owner, directPrivileges: old?.directPrivileges ?? [] };
      if (kind === "TRIGGER") {
        actual.triggerEnabled = input.triggerEnabled ?? true;
        actual.triggerEnabledRead = { ...available };
      }
      if (failure === "invalid") actual.status = "INVALID";
      objects.set(objectKey, actual);
      if (input.operation === "save_spec") {
        const paired = objects.get(identity(input.name, "TYPE BODY", input.owner));
        if (paired) paired.status = "INVALID";
      }
      // A replacement definition which no longer mentions ROOT removes that edge.
      if (input.name !== "ROOT" && !input.source?.includes('"ROOT"')) edges = edges.filter((item) => !(typeManagementObjectKey(item) === objectKey && item.referencedName === "ROOT"));
    }
    if (failure === "network-after") throw new Error("Lost response after applying DDL");
    return { execution_error: false, error: null, messages: [], rows: [] } as never;
  });
});

describe("controlled TYPE plans", () => {
  it.each([false, true])("preserves trigger enabled=%s through failed rebuild, durable reopen and repair", async (enabled) => {
    isolateRoot();
    const source = 'CREATE OR REPLACE TRIGGER "APP"."TRG" BEFORE INSERT ON "APP"."DATA" FOR EACH ROW BEGIN DECLARE X "APP"."ROOT"; BEGIN NULL; END; END;';
    const trigger = { ...object("TRG", "TRIGGER", source, "7"), triggerEnabled: enabled, triggerEnabledRead: available };
    objects.set(identity("TRG", "TRIGGER"), trigger);
    edges.push(edge("TRG", "TRIGGER", "ROOT"));
    fault = (input) => (input.objectType === "TRIGGER" ? "invalid" : undefined);
    const plan = await prepareOracleTypeManagement(target, "save-spec", [draft()]);
    const triggerStep = plan.steps.find((step) => step.object.objectType === "TRIGGER")!;
    expect(statements.get(triggerStep.sql)?.triggerEnabled).toBe(enabled);
    const saved: OracleTypeManagementDraft[] = [];
    await expect(
      executeOracleTypeManagement(plan, {
        persist: async (value) => {
          saved.push(json(value));
        },
      }),
    ).rejects.toThrow("INVALID");
    expect(objects.get(identity("TRG", "TRIGGER"))?.triggerEnabled).toBe(enabled);
    const beforeResume = requests.length;
    fault = undefined;
    const reopened = restoreOracleTypeManagementDraft(saved.at(-1))!;
    const repaired = source.replace("NULL; END; END;", "NULL; NULL; END; END;");
    const remaining = await prepareOracleTypeManagement(
      target,
      "save-spec",
      reopened.drafts.map((item) => (item.objectType === "TRIGGER" ? { ...item, source: repaired } : item)),
      reopened,
    );
    expect(remaining.issues).toEqual([]);
    await executeOracleTypeManagement(remaining, { persist: async () => {} });
    expect(requests.slice(beforeResume)).toEqual([remaining.steps.find((step) => step.object.objectType === "TRIGGER")!.sql]);
    expect(objects.get(identity("TRG", "TRIGGER"))?.triggerEnabled).toBe(enabled);
  });

  it("blocks an unknown or concurrently changed trigger state before any TYPE write", async () => {
    isolateRoot();
    const source = 'CREATE TRIGGER "APP"."TRG" BEFORE INSERT ON "APP"."DATA" BEGIN NULL; END;';
    const trigger = { ...object("TRG", "TRIGGER", source, "7"), triggerEnabled: false as boolean | null, triggerEnabledRead: { ...available } as { state: "available" | "incomplete" } };
    objects.set(identity("TRG", "TRIGGER"), trigger);
    edges.push(edge("TRG", "TRIGGER", "ROOT"));
    trigger.triggerEnabled = null;
    trigger.triggerEnabledRead.state = "incomplete";
    expect((await prepareOracleTypeManagement(target, "save-spec", [draft()])).executable).toBe(false);
    trigger.triggerEnabled = false;
    trigger.triggerEnabledRead.state = "available";
    const plan = await prepareOracleTypeManagement(target, "save-spec", [draft()]);
    trigger.triggerEnabled = true;
    await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow("changed");
    expect(requests).toEqual([]);
  });

  it("keeps an unexpected trigger enablement unknown instead of confirming or replaying it", async () => {
    isolateRoot();
    const source = 'CREATE TRIGGER "APP"."TRG" BEFORE INSERT ON "APP"."DATA" BEGIN NULL; END;';
    objects.set(identity("TRG", "TRIGGER"), { ...object("TRG", "TRIGGER", source, "7"), triggerEnabled: false, triggerEnabledRead: { ...available } });
    edges.push(edge("TRG", "TRIGGER", "ROOT"));
    const plan = await prepareOracleTypeManagement(target, "save-spec", [draft()]);
    const execute = vi.mocked(api.executeConditionalUpdate).getMockImplementation()!;
    vi.mocked(api.executeConditionalUpdate).mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (statements.get(args[2])?.objectType === "TRIGGER") objects.get(identity("TRG", "TRIGGER"))!.triggerEnabled = true;
      return result;
    });
    await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow("not been verified");
    expect(plan.steps.find((step) => step.object.objectType === "TRIGGER")?.state).toBe("unknown");
    const sent = requests.length;
    const rechecked = await prepareOracleTypeManagement(target, "save-spec", plan.drafts, restoreOracleTypeManagementDraft(json(plan)));
    expect(rechecked.executable).toBe(false);
    expect(requests).toHaveLength(sent);
  });

  it("previews the transitive closure, reverse drops, paired BODY, forward rebuilds and grant options without executing", async () => {
    const plan = await prepareOracleTypeManagement(target, "save-spec", [draft()]);
    expect(plan.issues).toEqual([]);
    expect(plan.executable).toBe(true);
    expect(plan.steps.filter((step) => step.kind === "drop-dependent").map((step) => step.object.name)).toEqual(["DEEP", "COLL"]);
    const positions = (kind: string, name: string) => plan.steps.findIndex((step) => step.kind === kind && step.object.name === name);
    expect(positions("replace", "ROOT")).toBeLessThan(positions("rebuild", "COLL"));
    expect(positions("rebuild", "COLL")).toBeLessThan(positions("grant", "COLL"));
    expect(positions("grant", "COLL")).toBeLessThan(positions("rebuild", "PROC"));
    expect(plan.steps.find((step) => step.kind === "grant")?.sql).toContain("WITH GRANT OPTION");
    expect(plan.steps.some((step) => /\bFORCE\b/.test(step.sql))).toBe(false);
    expect(api.executeConditionalUpdate).not.toHaveBeenCalled();
  });

  it("keeps same-name kinds and case-sensitive owners distinct", () => {
    expect(identity("Mixed Type")).not.toBe(identity("MIXED TYPE"));
    expect(identity("ROOT")).not.toBe(identity("ROOT", "TYPE BODY"));
    expect(identity("ROOT", "TYPE", "App")).not.toBe(identity("ROOT", "TYPE", "APP"));
  });

  it.each(["oracle", "oceanbase-oracle", "dameng"] as const)("uses the native %s builder for the same no-data closure", async (databaseType) => {
    const plan = await prepareOracleTypeManagement({ ...target, databaseType }, "save-spec", [draft()]);
    expect(plan.executable).toBe(true);
    expect(vi.mocked(api.buildOracleTypeManagementSql).mock.calls.every(([input]) => input.databaseType === databaseType)).toBe(true);
    expect(plan.steps.some((step) => /ALTER TYPE|COMPILE/.test(step.sql))).toBe(false);
  });

  it("retains generated work and editable definitions when metadata or one definition needs repair", async () => {
    objects.get(identity("FN", "FUNCTION"))!.source = null;
    objects.get(identity("FN", "FUNCTION"))!.sourceRead = { state: "unavailable", reason: "Source permission missing" };
    snapshotFault = (value) => {
      value.dependenciesRead = { state: "incomplete", reason: "Truncated" };
    };
    const plan = await prepareOracleTypeManagement(target, "save-spec", [draft("COLL", "BAD_DECLARATION")]);
    expect(plan.executable).toBe(false);
    expect(plan.issues.map((issue) => issue.code)).toContain("invalid-definition");
    expect(plan.issues.map((issue) => issue.code)).toContain("incomplete-metadata");
    expect(plan.drafts.find((item) => item.name === "COLL")?.source).toBe("BAD_DECLARATION");
    expect(plan.drafts.find((item) => item.name === "FN")?.source).toBe("");
    expect(plan.steps.length).toBeGreaterThan(2);
    expect(api.executeConditionalUpdate).not.toHaveBeenCalled();
  });

  it("does not silently drop persistent values, unknown grants, remote edges, or cyclic dependencies", async () => {
    objects.get(identity("COLL"))!.directPrivileges[0].grantor = "ORIGINAL_GRANTOR";
    edges.push(edge("COLL", "TYPE", "DEEP"));
    snapshotFault = (value) => {
      value.persistentReferences.push({ owner: "APP", tableName: "DATA", columnName: "VALUE", dataType: "ROOT", dataTypeOwner: "APP", tableReadOnly: false });
      value.dependencies.push({ ...edge("REMOTE", "PROCEDURE", "ROOT"), referencedLink: "REMOTE_DB" });
    };
    const plan = await prepareOracleTypeManagement(target, "save-spec", [draft()]);
    expect(plan.executable).toBe(false);
    expect(plan.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["persistent-mapping", "database-link", "dependency-cycle"]));
    expect(plan.drafts.length).toBeGreaterThan(1);
  });

  it("requires editable unlink definitions for deletion and verifies real edges before the final DROP", async () => {
    const initial = await prepareOracleTypeManagement(target, "delete-spec");
    expect(initial.issues.filter((issue) => issue.code === "unlink-required")).toHaveLength(2);
    const unlinks = initial.drafts.map((item) => ({ ...item, source: item.name === "ROOT" ? item.source : item.source.replaceAll('"ROOT"', '"ALTERNATE"') }));
    const plan = await prepareOracleTypeManagement(target, "delete-spec", unlinks);
    expect(plan.executable).toBe(true);
    expect(plan.steps.at(-1)?.kind).toBe("delete");
    await executeOracleTypeManagement(plan, { persist: async () => {} });
    expect(objects.has(identity("ROOT"))).toBe(false);
    expect(objects.has(identity("ROOT", "TYPE BODY"))).toBe(false);
    expect(objects.get(identity("COLL"))?.source).toContain('"ALTERNATE"');
    expect(objects.has(identity("PROC", "PROCEDURE"))).toBe(true);
  });

  it("deletes only the BODY while retaining the specification and its other dependents", async () => {
    const plan = await prepareOracleTypeManagement(target, "delete-body");
    expect(plan.steps).toHaveLength(1);
    await executeOracleTypeManagement(plan, { persist: async () => {} });
    expect(objects.has(identity("ROOT"))).toBe(true);
    expect(objects.has(identity("ROOT", "TYPE BODY"))).toBe(false);
    expect(objects.has(identity("COLL"))).toBe(true);
  });
});

describe("TYPE execution, persistence and recovery", () => {
  it.each([
    { requested: false, terminal: false, databaseTerminal: false },
    { requested: false, terminal: true, databaseTerminal: false },
    { requested: false, terminal: true },
  ])("keeps an INVALID execution active across repeated edited previews without database completion: %j", async (completion) => {
    isolateRoot();
    fault = () => "invalid";
    const execute = vi.mocked(api.executeConditionalUpdate).getMockImplementation()!;
    vi.mocked(api.executeConditionalUpdate).mockImplementation(async (...args) => {
      await execute(...args);
      throw new Error("Lost INVALID response");
    });
    vi.mocked(api.cancelConditionalUpdate).mockResolvedValue(completion);
    const plan = await prepareOracleTypeManagement(target, "save-body", [draft("ROOT", body, "TYPE BODY")]);
    const saved: OracleTypeManagementDraft[] = [];
    await expect(
      executeOracleTypeManagement(plan, {
        persist: async (value) => {
          saved.push(json(value));
        },
      }),
    ).rejects.toThrow("Lost INVALID response");
    const sent = saved.find((record) => record.steps[0].state === "sent")!;
    expect(sent.steps[0].executionId).toBeTruthy();
    expect(api.executeConditionalUpdate).toHaveBeenCalledWith(target.connectionId, target.database, body, "APP", sent.steps[0].executionId, { typeRecovery: { planId: sent.planId, stepId: sent.steps[0].id } });
    let reopened = restoreOracleTypeManagementDraft(saved.at(-1))!;
    for (const value of ["2", "3"]) {
      const revised = [draft("ROOT", body.replace("RETURN SELF.ID", `RETURN ${value}`), "TYPE BODY")];
      reopened = await prepareOracleTypeManagement(target, "save-body", revised, reopened);
      expect(reopened.executable).toBe(false);
      expect(reopened.issues.map((issue) => issue.code)).toContain("unknown-result");
      expect(reopened.steps[0].executionId).toBe(sent.steps[0].executionId);
      expect(reopened.steps[0].state).toBe("unknown");
      expect(reopened.drafts).toEqual(revised);
      await expect(executeOracleTypeManagement(reopened, { persist: async () => {} })).rejects.toThrow("Revalidate");
    }
    expect(api.executeConditionalUpdate).toHaveBeenCalledOnce();
    for (const [id, options] of vi.mocked(api.cancelConditionalUpdate).mock.calls) {
      expect(id).toBe(sent.steps[0].executionId);
      expect(options).toEqual({ cancel: false, typeRecovery: { executionId: id, planId: sent.planId, stepId: sent.steps[0].id, connectionId: target.connectionId, database: target.database, schema: "APP", sql: body } });
    }
  });

  it("restores the original binding after a lost response and confirms durable completion without resending", async () => {
    isolateRoot();
    const execute = vi.mocked(api.executeConditionalUpdate).getMockImplementation()!;
    vi.mocked(api.executeConditionalUpdate).mockImplementation(async (...args) => {
      await execute(...args);
      throw new Error("Response lost before restart");
    });
    vi.mocked(api.cancelConditionalUpdate).mockResolvedValue({ requested: false, terminal: false, databaseTerminal: false });
    const desired = body.replace("RETURN SELF.ID", "RETURN SELF.ID + 11");
    const plan = await prepareOracleTypeManagement(target, "save-body", [draft("ROOT", desired, "TYPE BODY")]);
    await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow("Response lost");
    const restored = restoreOracleTypeManagementDraft(json(plan))!;
    vi.mocked(api.cancelConditionalUpdate).mockImplementation(async (id, options) => {
      expect(options).toEqual({ cancel: false, typeRecovery: { executionId: id, planId: plan.planId, stepId: plan.steps[0].id, connectionId: target.connectionId, database: target.database, schema: "APP", sql: desired } });
      return { requested: false, terminal: true, databaseTerminal: true };
    });
    const recovered = await prepareOracleTypeManagement(target, "save-body", restored.drafts, restored);
    expect(recovered.state).toBe("complete");
    expect(api.executeConditionalUpdate).toHaveBeenCalledOnce();
  });

  it("waits for the original completion before taking the snapshot that makes INVALID repairable", async () => {
    isolateRoot();
    fault = () => "network-before";
    vi.mocked(api.cancelConditionalUpdate).mockResolvedValue({ requested: false, terminal: false, databaseTerminal: false });
    const desired = body.replace("RETURN SELF.ID", "RETURN SELF.ID + 7");
    const plan = await prepareOracleTypeManagement(target, "save-body", [draft("ROOT", desired, "TYPE BODY")]);
    await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow();
    vi.mocked(api.cancelConditionalUpdate).mockImplementation(async () => {
      const current = objects.get(identity("ROOT", "TYPE BODY"))!;
      current.source = current.sourceFingerprint = desired;
      current.status = "INVALID";
      return { requested: false, terminal: true, databaseTerminal: true };
    });
    const rechecked = await prepareOracleTypeManagement(target, "save-body", plan.drafts, restoreOracleTypeManagementDraft(json(plan)));
    expect(rechecked.executable).toBe(true);
    expect(rechecked.issues).toEqual([]);
    expect(rechecked.history[0]).toMatchObject({ state: "failed", databaseTerminal: true, executionId: plan.steps[0].executionId });
    expect(rechecked.history[0].message).toContain("INVALID");
    expect(rechecked.lastSnapshot.objects.find((item) => item.objectType === "TYPE BODY")?.status).toBe("INVALID");
    expect(api.executeConditionalUpdate).toHaveBeenCalledOnce();
  });

  it("does not adopt a concurrent grant change as the baseline when an unknown result is rechecked repeatedly", async () => {
    isolateRoot();
    fault = () => "invalid";
    const execute = vi.mocked(api.executeConditionalUpdate).getMockImplementation()!;
    vi.mocked(api.executeConditionalUpdate).mockImplementation(async (...args) => {
      await execute(...args);
      throw new Error("Lost INVALID response");
    });
    vi.mocked(api.cancelConditionalUpdate).mockResolvedValue({ requested: false, terminal: false, databaseTerminal: false });
    const desired = body.replace("RETURN SELF.ID", "RETURN SELF.ID + 6");
    const plan = await prepareOracleTypeManagement(target, "save-body", [draft("ROOT", desired, "TYPE BODY")]);
    await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow();
    const accepted = typeManagementSnapshotIdentity(plan.lastSnapshot);
    objects.get(identity("ROOT"))!.directPrivileges = [{ grantor: "APP", grantee: "OTHER", privilege: "EXECUTE", grantable: true, hierarchy: false }];
    vi.mocked(api.cancelConditionalUpdate).mockResolvedValue({ requested: false, terminal: true, databaseTerminal: true });
    let previous = restoreOracleTypeManagementDraft(json(plan))!;
    for (let attempt = 0; attempt < 3; attempt++) {
      previous = await prepareOracleTypeManagement(target, "save-body", previous.drafts, previous);
      expect(previous.executable).toBe(false);
      expect(previous.steps[0].state).toBe("unknown");
      expect(typeManagementSnapshotIdentity(previous.lastSnapshot)).toBe(accepted);
      expect(previous.issues.map((issue) => issue.code)).toContain("unknown-result");
    }
    expect(api.executeConditionalUpdate).toHaveBeenCalledOnce();
  });

  it("keeps legacy INVALID records without execution IDs blocked and validates optional durable fields", async () => {
    isolateRoot();
    fault = () => "network-before";
    vi.mocked(api.cancelConditionalUpdate).mockResolvedValue({ requested: false, terminal: false, databaseTerminal: false });
    const plan = await prepareOracleTypeManagement(target, "save-body", [draft("ROOT", body, "TYPE BODY")]);
    await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow();
    delete plan.steps[0].executionId;
    delete plan.steps[0].databaseTerminal;
    const actual = objects.get(identity("ROOT", "TYPE BODY"))!;
    actual.status = "INVALID";
    const legacy = restoreOracleTypeManagementDraft(json(plan))!;
    vi.mocked(api.cancelConditionalUpdate).mockClear();
    const rechecked = await prepareOracleTypeManagement(target, "save-body", legacy.drafts, legacy);
    expect(rechecked.executable).toBe(false);
    expect(api.cancelConditionalUpdate).not.toHaveBeenCalled();
    expect(rechecked.steps[0].state).toBe("unknown");
    expect(restoreOracleTypeManagementDraft({ ...json(plan), steps: [{ ...plan.steps[0], databaseTerminal: true }] })).toBeUndefined();
    expect(restoreOracleTypeManagementDraft({ ...json(plan), steps: [{ ...plan.steps[0], executionId: 1 }] })).toBeUndefined();
  });

  it("repairs an INVALID write after its completed execution response was lost without replaying confirmed steps", async () => {
    fault = (input) => (input.operation === "rebuild_source" && input.objectType === "TYPE_BODY" ? "invalid" : undefined);
    const execute = vi.mocked(api.executeConditionalUpdate).getMockImplementation()!;
    vi.mocked(api.executeConditionalUpdate).mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (statements.get(args[2])?.objectType === "TYPE_BODY") throw new Error("Lost response after completed INVALID DDL");
      return result;
    });
    const plan = await prepareOracleTypeManagement(target, "save-spec", [draft()]);
    await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow();
    expect(objects.get(identity("ROOT", "TYPE BODY"))?.status).toBe("INVALID");
    const sent = requests.length;
    const restored = restoreOracleTypeManagementDraft(json(plan))!;
    const reconciled = await prepareOracleTypeManagement(target, "save-spec", restored.drafts, restored);
    expect(reconciled.issues).toEqual([]);
    fault = undefined;
    vi.mocked(api.executeConditionalUpdate).mockImplementation(execute);
    const fixed = reconciled.drafts.map((item) => (item.objectType === "TYPE BODY" ? { ...item, source: item.source.replace("RETURN SELF.ID", "RETURN SELF.ID + 1") } : item));
    const remaining = await prepareOracleTypeManagement(target, "save-spec", fixed, reconciled);
    expect(remaining.issues).toEqual([]);
    await executeOracleTypeManagement(remaining, { persist: async () => {} });
    expect(remaining.state).toBe("complete");
    expect(requests.slice(sent).every((sql) => !sql.startsWith("DROP TYPE") && sql !== changedRoot)).toBe(true);
    expect(objects.get(identity("ROOT", "TYPE BODY"))?.source).toContain("RETURN SELF.ID + 1");
  });

  it.each(["reject", "invalid"] as const)("keeps the %s attempt and diagnostic when reopening an unchanged failed draft", async (failure) => {
    isolateRoot();
    fault = () => failure;
    const plan = await prepareOracleTypeManagement(target, "save-body", [draft("ROOT", body.replace("RETURN SELF.ID", "RETURN SELF.ID + 4"), "TYPE BODY")]);
    await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow();
    const failed = json(plan.steps[0]);
    expect(failed.state).toBe("failed");
    expect(failed.message).toBeTruthy();
    const reopened = await prepareOracleTypeManagement(target, "save-body", plan.drafts, restoreOracleTypeManagementDraft(json(plan)));
    expect(reopened.history).toEqual([failed]);
    expect(reopened.steps[0].state).toBe("not-sent");
    expect(api.executeConditionalUpdate).toHaveBeenCalledOnce();
    const rechecked = await prepareOracleTypeManagement(target, "save-body", reopened.drafts, restoreOracleTypeManagementDraft(json(reopened)));
    expect(rechecked.history).toEqual([failed]);
    expect(api.executeConditionalUpdate).toHaveBeenCalledOnce();
    fault = () => (failure === "reject" ? "invalid" : "reject");
    await expect(executeOracleTypeManagement(rechecked, { persist: async () => {} })).rejects.toThrow();
    const secondFailure = json(rechecked.steps[0]);
    expect(secondFailure.id).toBe(failed.id);
    expect(secondFailure.message).not.toBe(failed.message);
    const retried = await prepareOracleTypeManagement(target, "save-body", rechecked.drafts, restoreOracleTypeManagementDraft(json(rechecked)));
    expect(retried.history).toEqual([failed, secondFailure]);
    const validatedAgain = await prepareOracleTypeManagement(target, "save-body", retried.drafts, restoreOracleTypeManagementDraft(json(retried)));
    expect(validatedAgain.history).toEqual(retried.history);
    expect(api.executeConditionalUpdate).toHaveBeenCalledTimes(2);
  });

  it("can revalidate a rejected grant with no effect and resume without dropping rebuilt types again", async () => {
    fault = (input) => (input.operation === "grant_privilege" ? "reject" : undefined);
    const plan = await prepareOracleTypeManagement(target, "save-spec", [draft()]);
    await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow();
    expect(plan.steps.find((step) => step.kind === "grant")?.state).toBe("failed");
    const writes = requests.length;
    fault = undefined;
    const next = await prepareOracleTypeManagement(target, "save-spec", plan.drafts, restoreOracleTypeManagementDraft(json(plan)));
    expect(next.issues).toEqual([]);
    await executeOracleTypeManagement(next, { persist: async () => {} });
    expect(next.state).toBe("complete");
    expect(requests.slice(writes)[0]).toMatch(/^GRANT/);
    expect(requests.slice(writes).some((sql) => sql.startsWith("DROP TYPE") || sql === changedRoot)).toBe(false);
  });
  it("does not turn a VALID but different post-write definition into a retryable failure", async () => {
    isolateRoot();
    const desired = body.replace("RETURN SELF.ID", "RETURN SELF.ID + 5");
    const concurrent = body.replace("RETURN SELF.ID", "RETURN SELF.ID + 9");
    const plan = await prepareOracleTypeManagement(target, "save-body", [draft("ROOT", desired, "TYPE BODY")]);
    const execute = vi.mocked(api.executeConditionalUpdate).getMockImplementation()!;
    vi.mocked(api.executeConditionalUpdate).mockImplementation(async (...args) => {
      const result = await execute(...args);
      const current = objects.get(identity("ROOT", "TYPE BODY"))!;
      current.source = current.sourceFingerprint = concurrent;
      return result;
    });
    await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow("not been verified");
    expect(plan.steps[0].state).toBe("unknown");
    const rechecked = await prepareOracleTypeManagement(target, "save-body", plan.drafts, restoreOracleTypeManagementDraft(json(plan)));
    expect(rechecked.executable).toBe(false);
    expect(rechecked.issues.map((issue) => issue.code)).toContain("unknown-result");
    expect(api.executeConditionalUpdate).toHaveBeenCalledOnce();
  });
  it("retains a terminal SQL rejection as failed and retries only after fresh validation and confirmation", async () => {
    isolateRoot();
    const changedBody = body.replace("RETURN SELF.ID", "RETURN SELF.ID + 8");
    const plan = await prepareOracleTypeManagement(target, "save-body", [draft("ROOT", changedBody, "TYPE BODY")]);
    const execute = vi.mocked(api.executeConditionalUpdate).getMockImplementation()!;
    vi.mocked(api.executeConditionalUpdate).mockRejectedValueOnce(
      new BackendErrorException({
        version: 1,
        code: "DBX-JDBC-4001",
        messageKey: "backendErrors.jdbc.sqlFailed",
        messageParams: {},
        source: "jdbcAgent",
        origin: { subsystem: "database", adapter: "jdbcAgent" },
        operationOutcome: "unknown",
        diagnostics: { category: "sql", stage: "execute" },
        detail: "Insufficient privileges",
      }),
    );
    await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow("Insufficient privileges");
    expect(plan.steps[0].state).toBe("failed");
    await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow("Revalidate");
    expect(api.executeConditionalUpdate).toHaveBeenCalledTimes(1);
    vi.mocked(api.executeConditionalUpdate).mockImplementation(execute);
    const resumed = await prepareOracleTypeManagement(target, "save-body", plan.drafts, restoreOracleTypeManagementDraft(json(plan)));
    expect(resumed.executable).toBe(true);
    await executeOracleTypeManagement(resumed, { persist: async () => {} });
    expect(resumed.state).toBe("complete");
    expect(api.executeConditionalUpdate).toHaveBeenCalledTimes(2);
  });

  it("flushes each exact sent revision before SQL and each readback before the next step", async () => {
    const plan = await prepareOracleTypeManagement(target, "save-spec", [draft()]);
    const saved: Array<{ revision: number; sent: number; confirmed: number; dispatched: number }> = [];
    const persist = async (value: OracleTypeManagementDraft) => {
      saved.push({ revision: value.revision, sent: value.steps.filter((step) => step.state === "sent").length, confirmed: value.steps.filter((step) => step.state === "confirmed").length, dispatched: requests.length });
    };
    await executeOracleTypeManagement(plan, { persist });
    expect(plan.state).toBe("complete");
    expect(plan.steps.every((step) => step.state === "confirmed")).toBe(true);
    expect(saved.filter((entry) => entry.sent).every((entry) => entry.dispatched === entry.confirmed)).toBe(true);
    expect(objects.get(identity("COLL"))?.directPrivileges[0].grantable).toBe(true);
    expect(objects.get(identity("ROOT", "TYPE BODY"))?.status).toBe("VALID");
  });

  it("does not dispatch when durable saving fails or confirmation becomes stale", async () => {
    isolateRoot();
    const first = await prepareOracleTypeManagement(target, "save-body", [draft("ROOT", body, "TYPE BODY")]);
    await expect(
      executeOracleTypeManagement(first, {
        persist: async () => {
          throw new Error("app_state write failed");
        },
      }),
    ).rejects.toBeInstanceOf(OracleTypeManagementFailure);
    expect(api.executeConditionalUpdate).not.toHaveBeenCalled();
    expect(first.steps[0].state).toBe("not-sent");
    const second = await prepareOracleTypeManagement(target, "save-body", [draft("ROOT", body, "TYPE BODY")]);
    let current = true;
    await expect(
      executeOracleTypeManagement(second, {
        persist: async () => {
          current = false;
        },
        isCurrent: () => current,
      }),
    ).rejects.toThrow("changed before dispatch");
    expect(api.executeConditionalUpdate).not.toHaveBeenCalled();
  });

  it("binds dispatched steps to the approved target even if the UI switches later", async () => {
    const plan = await prepareOracleTypeManagement(target, "save-spec", [draft()]);
    await executeOracleTypeManagement(plan, { persist: async () => {}, isCurrent: () => requests.length === 0 });
    expect(plan.state).toBe("complete");
    expect(vi.mocked(api.executeConditionalUpdate).mock.calls.every(([connection, database]) => connection === target.connectionId && database === target.database)).toBe(true);
  });

  it("detects source/grant/dependency concurrency before sending any DDL", async () => {
    const plan = await prepareOracleTypeManagement(target, "save-spec", [draft()]);
    objects.get(identity("FN", "FUNCTION"))!.source += " -- concurrent";
    await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow("changed");
    expect(api.executeConditionalUpdate).not.toHaveBeenCalled();
  });

  it("does not call INVALID with zero errors a success; repaired BODY resumes without replaying the root or drops", async () => {
    fault = (input) => (input.operation === "rebuild_source" && input.objectType === "TYPE_BODY" ? "invalid" : undefined);
    const plan = await prepareOracleTypeManagement(target, "save-spec", [draft()]);
    await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow("INVALID");
    expect(plan.state).toBe("stopped");
    const writes = requests.length;
    const restored = restoreOracleTypeManagementDraft(json(plan))!;
    expect(restored.requiresReverify).toBe(true);
    await expect(executeOracleTypeManagement(restored, { persist: async () => {} })).rejects.toThrow("Revalidate");
    fault = undefined;
    const fixed = restored.drafts.map((item) => (item.objectType === "TYPE BODY" ? { ...item, source: item.source.replace("RETURN SELF.ID", "RETURN SELF.ID + 1") } : item));
    const remaining = await prepareOracleTypeManagement(target, "save-spec", fixed, restored);
    expect(remaining.issues).toEqual([]);
    await executeOracleTypeManagement(remaining, { persist: async () => {} });
    expect(requests.slice(writes).every((sql) => !sql.startsWith("DROP TYPE") && sql !== changedRoot)).toBe(true);
    expect(remaining.history.some((step) => step.state === "failed" && step.object.objectType === "TYPE BODY")).toBe(true);
  });

  it("confirms a lost response from actual state and never resends an unresolved unknown write", async () => {
    isolateRoot();
    fault = (input) => (input.operation === "save_body" ? "network-after" : undefined);
    const applied = await prepareOracleTypeManagement(target, "save-body", [draft("ROOT", body, "TYPE BODY")]);
    await executeOracleTypeManagement(applied, { persist: async () => {} });
    expect(requests).toHaveLength(1);
    expect(applied.steps[0].state).toBe("confirmed");

    fault = () => "network-before";
    const changedBody = body.replace("RETURN SELF.ID", "RETURN SELF.ID + 2");
    const unknown = await prepareOracleTypeManagement(target, "save-body", [draft("ROOT", changedBody, "TYPE BODY")]);
    await expect(executeOracleTypeManagement(unknown, { persist: async () => {} })).rejects.toThrow("unknown");
    expect(unknown.steps[0].state).toBe("unknown");
    const attempts = requests.length;
    const rechecked = await prepareOracleTypeManagement(target, "save-body", unknown.drafts, restoreOracleTypeManagementDraft(json(unknown)));
    expect(rechecked.executable).toBe(false);
    expect(rechecked.issues.map((issue) => issue.code)).toContain("unknown-result");
    expect(requests).toHaveLength(attempts);
  });

  it("does not hide an applied write when readback fails, and stops later sends", async () => {
    isolateRoot();
    const plan = await prepareOracleTypeManagement(target, "save-spec", [draft()]);
    const implementation = vi.mocked(api.executeConditionalUpdate).getMockImplementation()!;
    vi.mocked(api.executeConditionalUpdate).mockImplementation(async (...args) => {
      const result = await implementation(...args);
      vi.mocked(api.getOracleTypeManagementSnapshot).mockRejectedValue(new Error("Readback unavailable"));
      return result;
    });
    await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow("Readback unavailable");
    expect(objects.get(identity("ROOT"))?.source).toBe(changedRoot);
    expect(plan.steps[0].state).toBe("unknown");
    expect(requests).toHaveLength(1);
  });

  it("does not depend on response order, but preserves precise identity, grants and definitions in concurrency checks", () => {
    const first = snapshot();
    const reordered = json(first);
    reordered.target = { owner: first.target.owner, name: first.target.name, database: first.target.database, connectionId: first.target.connectionId };
    reordered.objects.reverse();
    reordered.dependencies.reverse();
    expect(typeManagementSnapshotIdentity(first)).toBe(typeManagementSnapshotIdentity(reordered));
    reordered.objects[0].source += " -- changed";
    expect(typeManagementSnapshotIdentity(first)).not.toBe(typeManagementSnapshotIdentity(reordered));
    expect(restoreOracleTypeManagementDraft({ version: 1, executable: true })).toBeUndefined();
  });
});
