import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { executeOracleTypeDataInsert, prepareOracleTypeDataInsert, verifyOracleTypeDataMappings } from "@/lib/table/oracleTypeDataMapping";
import { executeOracleTypeManagement, prepareOracleTypeManagement, registerOracleTypeDataMapping, restoreOracleTypeManagementDraft, type OracleTypeManagementDraft, type TypeManagementTarget } from "@/lib/table/oracleTypeManagement";
import type { OracleTypeDataBaseline, OracleTypeDataManifest, OracleTypeDataMappingInput, OracleTypeManagementSnapshot } from "@/types/database";

vi.mock("@/lib/backend/api", () => ({ getOracleTypeManagementSnapshot: vi.fn(), buildOracleTypeManagementSql: vi.fn(), executeQuery: vi.fn(), executeConditionalUpdate: vi.fn(), verifyOracleTypeData: vi.fn() }));
const target: TypeManagementTarget = { connectionId: "mapping-test", database: "db", owner: "APP", name: "ROOT", databaseType: "oceanbase-oracle" };
const read = { state: "available" as const };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const original = 'CREATE OR REPLACE TYPE "APP"."ROOT" AS OBJECT (ID NUMBER);';
const changed = 'CREATE OR REPLACE TYPE "APP"."ROOT" AS OBJECT (ID NUMBER, LABEL VARCHAR2(40));';
const relation = (name: string) => ({ owner: "APP", name });
const mapping: OracleTypeDataMappingInput = {
  id: "permanent-original",
  source: relation("SRC"),
  old: relation("OLD"),
  expected: relation("EXPECTED"),
  target: relation("RESULT"),
  fields: [{ sourcePath: ["ID"], objectNull: false, oldColumn: "ID", expectedColumn: "ID", targetPath: ["ID"], unchanged: true }],
};
function baseline(name: string, rows: number, readonly: boolean): OracleTypeDataBaseline {
  return { relation: { relation: relation(name), objectId: `9007199254740993-${name}`, readOnly: readonly, structure: `metadata-${name}`, projection: [{ path: ["ID"], objectNull: false, dataType: "NUMBER(38,0)" }] }, rowCount: rows, fingerprint: "a".repeat(64) };
}
function manifest(): OracleTypeDataManifest {
  return { mapping: copy(mapping), original: baseline("SRC", 3, false), old: baseline("OLD", 3, true), expected: baseline("EXPECTED", 3, true), preparedTarget: null, verifiedTarget: null };
}
function snapshot(): OracleTypeManagementSnapshot {
  return {
    target,
    visibilityScope: "current-user-visible-dictionaries",
    actingUser: "APP",
    actingUserRead: read,
    detailsRead: read,
    typeSource: original,
    typeSourceRead: read,
    bodySource: null,
    bodySourceRead: read,
    objects: [
      { owner: "APP", name: "ROOT", objectType: "TYPE", exists: true, objectId: "root-id", status: "VALID", source: original, sourceFingerprint: original, sourceRead: read, statusRead: read, errors: [], errorsRead: read, directPrivileges: [], privilegesRead: read },
      { owner: "APP", name: "ROOT", objectType: "TYPE BODY", exists: false, objectId: null, status: null, source: null, sourceFingerprint: null, sourceRead: read, statusRead: read, errors: [], errorsRead: read, directPrivileges: [], privilegesRead: { state: "unsupported" } },
      {
        owner: "APP",
        name: "SRC",
        objectType: "TABLE",
        exists: true,
        objectId: baseline("SRC", 3, false).relation.objectId,
        status: "VALID",
        source: null,
        sourceRead: { state: "unsupported" },
        statusRead: read,
        errors: [],
        errorsRead: { state: "unsupported" },
        directPrivileges: [],
        privilegesRead: { state: "unsupported" },
      },
    ],
    dependencies: [{ owner: "APP", name: "SRC", objectType: "TABLE", referencedOwner: "APP", referencedName: "ROOT", referencedType: "TYPE" }],
    dependenciesRead: read,
    persistentReferences: [{ owner: "APP", tableName: "SRC", columnName: "VALUE", dataTypeOwner: "APP", dataType: "ROOT" }],
    persistentReferencesRead: read,
    directPrivileges: [],
    privilegesRead: read,
  };
}
let actual: OracleTypeManagementSnapshot;
let targetFilled: boolean;
let verifyFailure: boolean;
let baselineChanged: boolean;
const sql = 'INSERT INTO "APP"."RESULT" ("ID") SELECT "ID" FROM "APP"."EXPECTED";';
beforeEach(() => {
  vi.clearAllMocks();
  actual = snapshot();
  targetFilled = false;
  verifyFailure = false;
  baselineChanged = false;
  vi.mocked(api.getOracleTypeManagementSnapshot).mockImplementation(async () => copy(actual));
  vi.mocked(api.buildOracleTypeManagementSql).mockImplementation(async (input) => ({ statements: [input.source!], sourceFingerprint: input.source }));
  vi.mocked(api.verifyOracleTypeData).mockImplementation(async (input) => {
    if (input.action === "register") return { manifest: manifest() };
    const record = copy(input.manifest!);
    if (baselineChanged) record.old.fingerprint = "b".repeat(64);
    if (input.action === "validate_insert") {
      if (targetFilled) throw new Error("Target is not empty");
      record.preparedTarget = baseline("RESULT", 0, false);
      return { manifest: record, insertSql: sql };
    }
    if (verifyFailure || !targetFilled) throw new Error("Actual target does not match the complete EXPECTED relation");
    record.verifiedTarget = baseline("RESULT", 3, false);
    // SQLite JSON storage and Rust serialization need not retain property order.
    record.mapping.source = { name: record.mapping.source.name, owner: record.mapping.source.owner };
    return { manifest: record };
  });
  vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, statement) => {
    if (statement === sql) targetFilled = true;
    else {
      actual.objects[0].source = actual.objects[0].sourceFingerprint = statement;
      actual.typeSource = statement;
    }
    return { execution_error: false, messages: [], rows: [] } as never;
  });
  vi.mocked(api.executeConditionalUpdate).mockImplementation((...args) => api.executeQuery(...args));
});
async function registered(nextSource = changed): Promise<OracleTypeManagementDraft> {
  const plan = await prepareOracleTypeManagement(target, "save-spec", [{ owner: "APP", name: "ROOT", objectType: "TYPE", source: nextSource }]);
  return registerOracleTypeDataMapping(plan, mapping, async () => {});
}
function unlink() {
  actual.persistentReferences = [];
  actual.dependencies = [];
  actual.objects[2].exists = false;
  actual.objects[2].objectId = null;
}

describe("durable TYPE data mapping and bounded execution", () => {
  it("resumes a later BODY failure on another session with the original permanent baselines and no root replay", async () => {
    const oldSpec = original.replace("ID NUMBER", "ID NUMBER, MEMBER FUNCTION F RETURN NUMBER");
    const newSpec = changed.replace("LABEL VARCHAR2(40)", "LABEL VARCHAR2(40), MEMBER FUNCTION F RETURN NUMBER");
    const body = 'CREATE OR REPLACE TYPE BODY "APP"."ROOT" AS MEMBER FUNCTION F RETURN NUMBER IS BEGIN RETURN 1; END; END;';
    actual.typeSource = oldSpec;
    actual.objects[0].source = actual.objects[0].sourceFingerprint = oldSpec;
    Object.assign(actual.objects[1], { exists: true, objectId: "body-id", status: "VALID", source: body, sourceFingerprint: body });
    let rejectBody = true;
    vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, statement) => {
      const index = statement.includes("TYPE BODY") ? 1 : 0;
      actual.objects[index].source = actual.objects[index].sourceFingerprint = statement;
      if (index === 0) {
        actual.typeSource = statement;
        actual.objects[1].status = "INVALID";
      } else actual.objects[1].status = rejectBody ? "INVALID" : "VALID";
      return { execution_error: false, messages: [], rows: [] } as never;
    });
    const record = await registered(newSpec);
    targetFilled = true;
    unlink();
    const plan = await prepareOracleTypeManagement(target, "save-spec", record.drafts, record);
    await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow("INVALID");
    expect(plan.steps[0].state).toBe("confirmed");
    const persisted = copy(plan);
    const restored = restoreOracleTypeManagementDraft(persisted)!;
    const repaired = restored.drafts.map((draft) => (draft.objectType === "TYPE BODY" ? { ...draft, source: body.replace("RETURN 1", "RETURN 2") } : draft));
    rejectBody = false;
    const next = await prepareOracleTypeManagement(target, "save-spec", repaired, restored);
    expect(next.issues).toEqual([]);
    const writes = vi.mocked(api.executeQuery).mock.calls.length;
    await executeOracleTypeManagement(next, { persist: async () => {} });
    expect(next.state).toBe("complete");
    expect(
      vi
        .mocked(api.executeQuery)
        .mock.calls.slice(writes)
        .map((call) => call[2]),
    ).toEqual([body.replace("RETURN 1", "RETURN 2")]);
    expect(next.dataMappings[0].manifest.old).toEqual(record.dataMappings[0].manifest.old);
    expect(next.dataMappings[0].manifest.expected).toEqual(record.dataMappings[0].manifest.expected);
  });
  it("registers while original data is live, saves the manifest and never replaces an existing baseline", async () => {
    const plan = await prepareOracleTypeManagement(target, "save-spec", [{ owner: "APP", name: "ROOT", objectType: "TYPE", source: changed }]);
    const persist = vi.fn(async () => {});
    const saved = await registerOracleTypeDataMapping(plan, mapping, persist);
    expect(saved.dataMappings[0].manifest.old.fingerprint).toBe("a".repeat(64));
    expect(persist).toHaveBeenCalledWith(saved);
    expect(api.executeQuery).not.toHaveBeenCalled();
    await expect(registerOracleTypeDataMapping(saved, mapping, persist)).rejects.toThrow("cannot be replaced");
    expect(api.verifyOracleTypeData).toHaveBeenCalledTimes(1);
  });
  it("retains original baselines across restore and external preparation, then completes remaining TYPE steps", async () => {
    const plan = await registered();
    targetFilled = true;
    unlink();
    const restored = restoreOracleTypeManagementDraft(copy(plan))!;
    expect(restored.executable).toBe(false);
    const next = await prepareOracleTypeManagement(target, "save-spec", restored.drafts, restored);
    expect(next.issues).toEqual([]);
    expect(next.originalSnapshot.persistentReferences).toHaveLength(1);
    expect(next.dataMappings[0].manifest.verifiedTarget?.rowCount).toBe(3);
    const persist = vi.fn(async () => {});
    await executeOracleTypeManagement(next, { persist });
    expect(next.state).toBe("complete");
    expect(api.executeQuery).toHaveBeenCalledOnce();
    expect(api.verifyOracleTypeData).toHaveBeenCalledTimes(4); // registration, revalidation, pre-DDL and post-DDL
    expect(next.dataMappings[0].manifest.old).toEqual(plan.dataMappings[0].manifest.old);
  });
  it("preserves the record and sends no TYPE SQL when the original baseline changes or references remain", async () => {
    const plan = await registered();
    targetFilled = true;
    const withReferences = await prepareOracleTypeManagement(target, "save-spec", plan.drafts, plan);
    expect(withReferences.executable).toBe(false);
    expect(withReferences.issues.some((issue) => issue.code === "persistent-mapping")).toBe(true);
    unlink();
    baselineChanged = true;
    const invalid = await prepareOracleTypeManagement(target, "save-spec", plan.drafts, plan);
    expect(invalid.issues.some((issue) => issue.code === "persistent-data")).toBe(true);
    expect(invalid.dataMappings[0].manifest.old.fingerprint).toBe("a".repeat(64));
    expect(api.executeQuery).not.toHaveBeenCalled();
  });
  it("previews against the registered empty target, flushes sent state, and verifies all target values", async () => {
    const plan = await registered();
    const preview = await prepareOracleTypeDataInsert(plan, mapping.id, sql, async () => {});
    expect(api.executeQuery).not.toHaveBeenCalled();
    const persist = vi.fn(async (value: OracleTypeManagementDraft) => {
      if (value.dataMappings[0].insertState === "sent") expect(api.executeQuery).not.toHaveBeenCalled();
    });
    await executeOracleTypeDataInsert(preview, mapping.id, { persist });
    expect(preview.dataMappings[0].insertState).toBe("confirmed");
    expect(api.executeQuery).toHaveBeenCalledWith(target.connectionId, target.database, sql, "APP");
    expect(preview.dataMappings[0].manifest.old).toEqual(plan.dataMappings[0].manifest.old);
  });
  it("does not insert if persistence or confirmation fails", async () => {
    const plan = await registered();
    const preview = await prepareOracleTypeDataInsert(plan, mapping.id, sql, async () => {});
    await expect(
      executeOracleTypeDataInsert(preview, mapping.id, {
        persist: async () => {
          throw new Error("SQLite unavailable");
        },
      }),
    ).rejects.toThrow("SQLite unavailable");
    expect(preview.dataMappings[0].insertState).toBe("not-sent");
    let current = true;
    await expect(
      executeOracleTypeDataInsert(preview, mapping.id, {
        persist: async () => {
          current = false;
        },
        isCurrent: () => current,
      }),
    ).rejects.toThrow("changed before dispatch");
    expect(api.executeQuery).not.toHaveBeenCalled();
  });
  it("reconciles an unknown INSERT from the original durable manifest without replay", async () => {
    const plan = await registered();
    const preview = await prepareOracleTypeDataInsert(plan, mapping.id, sql, async () => {});
    vi.mocked(api.executeQuery).mockRejectedValue(new Error("Lost response"));
    await expect(executeOracleTypeDataInsert(preview, mapping.id, { persist: async () => {} })).rejects.toThrow("Lost response");
    expect(preview.dataMappings[0].insertState).toBe("unknown");
    const restored = restoreOracleTypeManagementDraft(copy(preview))!;
    await expect(executeOracleTypeDataInsert(restored, mapping.id, { persist: async () => {} })).rejects.toThrow("Preview");
    targetFilled = true;
    await verifyOracleTypeDataMappings(restored);
    expect(restored.dataMappings[0].insertState).toBe("confirmed");
    expect(api.executeQuery).toHaveBeenCalledOnce();
  });
});
