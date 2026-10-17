import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { executeOracleRoutineRename, OracleRoutineRenameFailure, prepareOracleRoutineRename } from "@/lib/table/oracleRoutineRename";

vi.mock("@/lib/backend/api", () => ({
  parseOracleObjectName: vi.fn(async (name: string) => name.toUpperCase()),
  executeQuery: vi.fn(),
  rewriteOracleRoutineReferences: vi.fn(async ({ oldName, newName, source }: { oldName: string; newName: string; source: string }) => source.replaceAll(oldName, newName)),
  buildExecutableObjectSourceStatements: vi.fn(async ({ source }: { source: string }) => [source]),
  reviewOracleViewRenameSource: vi.fn(async ({ source, owner, viewName }: { source: string; owner: string; viewName: string }) => {
    const declaration = source.match(/CREATE(?:\s+OR\s+REPLACE)?\s+VIEW\s+(?:(\w+)\.)?(\w+)\s+AS/i);
    const valid = declaration && declaration[2].toUpperCase() === viewName.toUpperCase() && (!declaration[1] || declaration[1].toUpperCase() === owner.toUpperCase());
    return {
      source: valid ? { source: source.replace(/^\s*CREATE\s+VIEW/i, "CREATE OR REPLACE VIEW"), fingerprint: source, references: [] } : null,
      references: [],
      issues: valid ? [] : [{ code: "invalid_declaration", message: "The view declaration does not match the selected owner and name.", repairable: true }],
    };
  }),
  validateOracleExecutableObjectSource: vi.fn(async ({ source, objectType, schema, name }: { source: string; objectType: string; schema?: string | null; name: string }) => {
    const declaration = source.match(/CREATE(?:\s+OR\s+REPLACE)?\s+(PROCEDURE|FUNCTION)\s+(?:(\w+)\.)?(\w+)\s+(?:AS|IS)/i);
    if (!declaration || declaration[1] !== objectType || declaration[3].toUpperCase() !== name.toUpperCase() || (declaration[2] && declaration[2].toUpperCase() !== schema?.toUpperCase())) {
      throw new Error("Oracle object source declaration does not match the selected owner and name.");
    }
  }),
  fingerprintOracleRoutineObjectSource: vi.fn(async ({ source }: { source: string }) => source.replace(/\s+/g, "").replace(/;$/, "")),
  buildRoutineRenameObjectSourceStatements: vi.fn(async ({ name, newName, source }: { name: string; newName: string; source: string }) => {
    const renamed = source.replaceAll(name, newName);
    return [renamed.startsWith("CREATE OR REPLACE") ? renamed : `CREATE OR REPLACE ${renamed}`, `DROP PROCEDURE APP.${name}`];
  }),
}));

const target = { connectionId: "conn-1", database: "APP", databaseType: "oceanbase-oracle" as const, schema: "APP", objectType: "PROCEDURE" as const, oldName: "P_OLD", newName: "P_NEW" };
const rootSource = "CREATE OR REPLACE PROCEDURE APP.P_OLD AS BEGIN NULL; END;";
const firstCallerSource = "CREATE OR REPLACE PROCEDURE APP.CALLER_1 AS BEGIN APP.P_OLD; END;";
const secondCallerSource = "CREATE OR REPLACE PROCEDURE APP.CALLER_2 AS BEGIN APP.CALLER_1; END;";
const objects = new Map<string, { id: string; source: string; status?: string }>([
  ["PROCEDURE:P_OLD", { id: "101", source: rootSource }],
  ["PROCEDURE:CALLER_1", { id: "102", source: firstCallerSource }],
  ["PROCEDURE:CALLER_2", { id: "103", source: secondCallerSource }],
]);
let dependencyRows = new Map<string, unknown[][]>();
let grants = new Map<string, unknown[][]>();
let namespaceConflict = false;
let operatorNamespaceConflict = false;
let tamperCreatedAfterCaller = false;
let tamperCreatedOnCreate = false;
let dropErrorAfterDelete = false;
let invalidateCallerAAfterCallerZ = false;
let invalidateCreatedRoot = false;
let tamperCreatedDuringCompile = false;
let canonicalizeCallerReadback = false;
let canonicalizeRootReadback = false;
let mutateCallerBeforeDrop: "comment" | "string" | "call" | null = null;

function result(rows: unknown[][] = []) {
  return { rows, execution_error: false, error: null, truncated: false, has_more: false, large_value_cells: [] };
}

function sourceFromSql(sql: string) {
  const [, , name] = sql.match(/DBMS_METADATA\.GET_DDL\('([^']+)','([^']+)','([^']+)'\)/) ?? [];
  const [, type] = sql.match(/DBMS_METADATA\.GET_DDL\('([^']+)'/) ?? [];
  return objects.get(`${type}:${name}`)?.source ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.rewriteOracleRoutineReferences).mockImplementation(async ({ oldName, newName, source }) => source.replaceAll(oldName, newName));
  objects.clear();
  objects.set("PROCEDURE:P_OLD", { id: "101", source: rootSource });
  objects.set("PROCEDURE:CALLER_1", { id: "102", source: firstCallerSource });
  objects.set("PROCEDURE:CALLER_2", { id: "103", source: secondCallerSource });
  dependencyRows = new Map([
    ["PROCEDURE:P_OLD", [["APP", "CALLER_1", "PROCEDURE", null]]],
    ["PROCEDURE:CALLER_1", [["APP", "CALLER_2", "PROCEDURE", null]]],
    ["PROCEDURE:CALLER_2", []],
  ]);
  grants = new Map();
  namespaceConflict = false;
  operatorNamespaceConflict = false;
  tamperCreatedAfterCaller = false;
  tamperCreatedOnCreate = false;
  dropErrorAfterDelete = false;
  invalidateCallerAAfterCallerZ = false;
  invalidateCreatedRoot = false;
  tamperCreatedDuringCompile = false;
  canonicalizeCallerReadback = false;
  canonicalizeRootReadback = false;
  mutateCallerBeforeDrop = null;
  vi.mocked(api.executeQuery).mockImplementation(async (_connectionId, _database, sql) => {
    if (sql.startsWith("CREATE PROCEDURE APP.P_NEW")) {
      const source = (objects.get("PROCEDURE:P_OLD")?.source ?? rootSource).replaceAll("P_OLD", "P_NEW");
      const readback = canonicalizeRootReadback ? source.replace(/CREATE OR REPLACE PROCEDURE APP\.P_NEW\s+(?:AS|IS)\s+BEGIN/, "CREATE OR REPLACE PROCEDURE APP.P_NEW\n IS\nBEGIN") : source;
      objects.set("PROCEDURE:P_NEW", { id: "201", source: tamperCreatedOnCreate ? readback.replace("NULL", "RAISE") : readback, status: invalidateCreatedRoot ? "INVALID" : "VALID" });
      if (dependencyRows.get("PROCEDURE:P_OLD")?.some(([, name, type]) => name === "P_OLD" && type === "PROCEDURE")) {
        dependencyRows.set("PROCEDURE:P_NEW", [["APP", "P_NEW", "PROCEDURE", null]]);
      }
      return result() as never;
    }
    if (sql.startsWith("CREATE OR REPLACE PROCEDURE APP.CALLER_1")) {
      const source = canonicalizeCallerReadback ? sql.replace(/CREATE OR REPLACE PROCEDURE APP\.CALLER_1\s+(?:AS|IS)\s+BEGIN/, "CREATE OR REPLACE PROCEDURE APP.CALLER_1\n IS\nBEGIN") : sql;
      objects.set("PROCEDURE:CALLER_1", { id: "102", source });
      dependencyRows.set(
        "PROCEDURE:P_OLD",
        (dependencyRows.get("PROCEDURE:P_OLD") ?? []).filter(([, name, type]) => name === "P_OLD" && type === "PROCEDURE"),
      );
      dependencyRows.set("PROCEDURE:P_NEW", [...(dependencyRows.get("PROCEDURE:P_NEW") ?? []), ["APP", "CALLER_1", "PROCEDURE", null]]);
      if (tamperCreatedAfterCaller) objects.set("PROCEDURE:P_NEW", { id: "201", source: "CREATE OR REPLACE PROCEDURE APP.P_NEW AS BEGIN RAISE; END;" });
      return result() as never;
    }
    if (sql.startsWith("CREATE OR REPLACE VIEW APP.V_CALL")) {
      objects.set("VIEW:V_CALL", { id: "202", source: sql, status: "VALID" });
      dependencyRows.set(
        "PROCEDURE:P_OLD",
        (dependencyRows.get("PROCEDURE:P_OLD") ?? []).filter(([, name]) => name !== "V_CALL"),
      );
      dependencyRows.set("PROCEDURE:P_NEW", [...(dependencyRows.get("PROCEDURE:P_NEW") ?? []), ["APP", "V_CALL", "VIEW", null]]);
      return result() as never;
    }
    if (sql.startsWith("CREATE OR REPLACE PROCEDURE APP.CALLER_Z")) {
      objects.set("PROCEDURE:CALLER_Z", { id: "104", source: sql });
      dependencyRows.set("PROCEDURE:P_NEW", [...(dependencyRows.get("PROCEDURE:P_NEW") ?? []), ["APP", "CALLER_Z", "PROCEDURE", null]]);
      if (invalidateCallerAAfterCallerZ) objects.set("PROCEDURE:CALLER_A", { id: "105", source: objects.get("PROCEDURE:CALLER_A")!.source, status: "INVALID" });
      return result() as never;
    }
    if (sql.startsWith("CREATE OR REPLACE PROCEDURE APP.CALLER_A")) {
      objects.set("PROCEDURE:CALLER_A", { id: "105", source: sql, status: "VALID" });
      dependencyRows.set(
        "PROCEDURE:P_OLD",
        (dependencyRows.get("PROCEDURE:P_OLD") ?? []).filter(([, name, type]) => name === "P_OLD" && type === "PROCEDURE"),
      );
      dependencyRows.set("PROCEDURE:P_NEW", [...(dependencyRows.get("PROCEDURE:P_NEW") ?? []), ["APP", "CALLER_A", "PROCEDURE", null]]);
      return result() as never;
    }
    if (sql.startsWith("GRANT EXECUTE ON")) {
      grants.set("P_NEW", [["APP", "ALICE", "EXECUTE", "NO"]]);
      return result() as never;
    }
    if (sql.startsWith('ALTER PROCEDURE "APP"."P_NEW"')) {
      if (tamperCreatedDuringCompile) objects.set("PROCEDURE:P_NEW", { id: "202", source: "CREATE OR REPLACE PROCEDURE APP.P_NEW AS BEGIN RAISE; END;", status: "VALID" });
      else objects.set("PROCEDURE:P_NEW", { ...objects.get("PROCEDURE:P_NEW")!, status: "VALID" });
      return result() as never;
    }
    if (sql.startsWith('ALTER PROCEDURE "APP"."CALLER_2"') && mutateCallerBeforeDrop) {
      const caller = objects.get("PROCEDURE:CALLER_1")!;
      const source = mutateCallerBeforeDrop === "comment" ? caller.source.replace("APP.P_NEW;", "APP.P_NEW /* changed */;") : mutateCallerBeforeDrop === "string" ? caller.source.replace("'keep'", "'changed'") : caller.source.replace("APP.P_NEW", "APP.P_OTHER");
      objects.set("PROCEDURE:CALLER_1", { ...caller, source });
    }
    if (sql.startsWith("ALTER PROCEDURE")) return result() as never;
    if (sql.startsWith("DROP PROCEDURE APP.P_OLD")) {
      objects.delete("PROCEDURE:P_OLD");
      if (dropErrorAfterDelete) throw new Error("DROP response was lost");
      return result() as never;
    }
    if (sql === "SELECT USER, SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL") return result([["APP", "APP"]]) as never;
    if (sql.includes("FROM USER_OBJECTS")) {
      const names = [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]);
      const types = [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]);
      const rows: unknown[][] = [];
      for (const [key, object] of objects) {
        const [type, name] = key.split(":");
        if (names.includes(name) && types.includes(type)) rows.push([name, type, Number(object.id), object.status ?? "VALID"]);
      }
      if (namespaceConflict && names.includes("P_NEW") && types.includes("TABLE")) rows.push(["P_NEW", "TABLE", 999, "VALID"]);
      if (operatorNamespaceConflict && names.includes("P_NEW") && types.includes("OPERATOR")) rows.push(["P_NEW", "OPERATOR", 998, "VALID"]);
      return result(rows) as never;
    }
    if (sql.includes("DBMS_LOB.GETLENGTH")) return result([[sourceFromSql(sql).length]]) as never;
    if (sql.includes("DBMS_LOB.SUBSTR")) {
      const source = sourceFromSql(sql);
      const offsets = [...sql.matchAll(/SELECT (\d+) CHUNK_OFFSET/g)].map((match) => Number(match[1]));
      return result(offsets.map((offset) => [offset, source.slice(offset - 1, offset + 999)])) as never;
    }
    if (sql.includes("FROM ALL_ARGUMENTS")) return result([]) as never;
    if (sql.includes("FROM ALL_TAB_PRIVS")) {
      const [, name] = sql.match(/TABLE_NAME='([^']+)'/) ?? [];
      return result(grants.get(name) ?? []) as never;
    }
    if (sql.includes("FROM USER_ERRORS")) return result([]) as never;
    if (sql.includes("SYS.DBA_DEPENDENCIES") || sql.includes("SYS.ALL_DEPENDENCIES")) {
      const [, referencedName, referencedType] = sql.match(/REFERENCED_NAME='([^']+)' AND REFERENCED_TYPE='([^']+)'/) ?? [];
      return result(dependencyRows.get(`${referencedType}:${referencedName}`) ?? []) as never;
    }
    throw new Error(`Unexpected metadata query: ${sql}`);
  });
});

describe("prepareOracleRoutineRename", () => {
  it("reproduces a legal dynamic caller reference that blocks the routine rename plan", async () => {
    const original = "CREATE OR REPLACE PROCEDURE APP.CALLER_1 AS BEGIN EXECUTE IMMEDIATE 'BEGIN APP.P_OLD; END;'; END;";
    objects.set("PROCEDURE:CALLER_1", { id: "102", source: original });
    vi.mocked(api.rewriteOracleRoutineReferences).mockImplementation(async ({ source }) => {
      if (/APP\.P_OLD/i.test(source)) throw new Error("Dynamic routine references cannot be rewritten automatically.");
      return source;
    });

    const plan = await prepareOracleRoutineRename(target);

    expect(plan.executable).toBe(false);
    expect(plan.issues.some(({ code, objectName }) => code === "caller_rewrite_failed" && objectName === "CALLER_1")).toBe(true);
    expect(plan.steps).toEqual([]);
    expect(objects.get("PROCEDURE:CALLER_1")?.source).toBe(original);
  });

  it("retains a failed caller source and revalidates a manual correction", async () => {
    const original = "CREATE OR REPLACE PROCEDURE APP.CALLER_1 AS BEGIN EXECUTE IMMEDIATE 'BEGIN APP.P_OLD; END;'; END;";
    const corrected = "CREATE OR REPLACE PROCEDURE APP.CALLER_1 AS BEGIN EXECUTE IMMEDIATE 'BEGIN APP.P_NEW; END;'; END;";
    objects.set("PROCEDURE:CALLER_1", { id: "102", source: original });
    vi.mocked(api.rewriteOracleRoutineReferences).mockImplementation(async ({ oldName, newName, source }) => {
      if (/APP\.P_OLD/i.test(source)) throw new Error("Dynamic routine references cannot be rewritten automatically.");
      return source.replaceAll(oldName, newName);
    });

    const initial = await prepareOracleRoutineRename(target);
    expect(initial.executable).toBe(false);
    expect(initial.callers.find((caller) => caller.name === "CALLER_1")).toMatchObject({ draft: original });
    expect(initial.issues.some(({ code, objectName }) => code === "caller_rewrite_failed" && objectName === "CALLER_1")).toBe(true);

    const repaired = await prepareOracleRoutineRename(target, { "PROCEDURE:CALLER_1": corrected });
    expect(repaired.issues).toEqual([]);
    expect(repaired.executable).toBe(true);
    expect(repaired.callers.find((caller) => caller.name === "CALLER_1")).toMatchObject({ draft: corrected, rewrittenSource: corrected });
  });

  it("collects a two-level dependency closure but rewrites only the direct caller", async () => {
    const plan = await prepareOracleRoutineRename(target);

    expect(plan.executable).toBe(true);
    expect(plan.callers.map(({ name, rewriteRequired }) => [name, rewriteRequired])).toEqual([
      ["CALLER_1", true],
      ["CALLER_2", false],
    ]);
    expect(plan.steps.filter((step) => step.kind === "replace-caller").map((step) => step.objectName)).toEqual(["CALLER_1"]);
    expect(plan.dependencyEdges).toContain(JSON.stringify(["CALLER_1", "PROCEDURE", "APP", "CALLER_2", "PROCEDURE", null]));
    expect(api.rewriteOracleRoutineReferences).toHaveBeenCalledTimes(1);
    expect(api.rewriteOracleRoutineReferences).toHaveBeenCalledWith(expect.objectContaining({ oldName: "P_OLD", newName: "P_NEW", source: firstCallerSource }));
  });

  it("blocks a non-self dependency cycle before producing executable steps", async () => {
    dependencyRows.set("PROCEDURE:CALLER_1", [["APP", "P_OLD", "PROCEDURE", null]]);

    const plan = await prepareOracleRoutineRename(target);

    expect(plan.executable).toBe(false);
    expect(plan.issues.some(({ code }) => code === "dependency_cycle")).toBe(true);
    expect(plan.steps).toEqual([]);
  });

  it("keeps a caller self-recursion edge outside the topological cycle check", async () => {
    dependencyRows.set("PROCEDURE:CALLER_1", [
      ["APP", "CALLER_1", "PROCEDURE", null],
      ["APP", "CALLER_2", "PROCEDURE", null],
    ]);

    const plan = await prepareOracleRoutineRename(target);

    expect(plan.executable).toBe(true);
    expect(plan.steps.filter((step) => step.kind === "replace-caller").map((step) => step.objectName)).toEqual(["CALLER_1"]);
  });

  it("maps a recursive root edge to the renamed routine and verifies the new graph", async () => {
    dependencyRows.set("PROCEDURE:P_OLD", [
      ["APP", "P_OLD", "PROCEDURE", null],
      ["APP", "CALLER_1", "PROCEDURE", null],
    ]);
    const plan = await prepareOracleRoutineRename(target);

    await expect(executeOracleRoutineRename(plan)).resolves.toBeUndefined();

    expect(objects.has("PROCEDURE:P_OLD")).toBe(false);
    expect(dependencyRows.get("PROCEDURE:P_NEW")).toContainEqual(["APP", "P_NEW", "PROCEDURE", null]);
  });

  it("uses dependency order and repairs a direct caller invalidated by an earlier planned replacement", async () => {
    const callerASource = "CREATE OR REPLACE PROCEDURE APP.CALLER_A AS BEGIN APP.P_OLD; APP.CALLER_Z; END;";
    const callerZSource = "CREATE OR REPLACE PROCEDURE APP.CALLER_Z AS BEGIN APP.P_OLD; END;";
    objects.set("PROCEDURE:CALLER_A", { id: "105", source: callerASource });
    objects.set("PROCEDURE:CALLER_Z", { id: "104", source: callerZSource });
    dependencyRows = new Map([
      [
        "PROCEDURE:P_OLD",
        [
          ["APP", "CALLER_A", "PROCEDURE", null],
          ["APP", "CALLER_Z", "PROCEDURE", null],
        ],
      ],
      ["PROCEDURE:CALLER_Z", [["APP", "CALLER_A", "PROCEDURE", null]]],
      ["PROCEDURE:CALLER_A", []],
    ]);
    invalidateCallerAAfterCallerZ = true;
    const plan = await prepareOracleRoutineRename(target);

    expect(plan.steps.filter((step) => step.kind === "replace-caller").map((step) => step.objectName)).toEqual(["CALLER_Z", "CALLER_A"]);
    await expect(executeOracleRoutineRename(plan)).resolves.toBeUndefined();

    expect(objects.get("PROCEDURE:CALLER_A")?.status).toBe("VALID");
  });

  it("blocks a conflicting object in the shared schema namespace", async () => {
    namespaceConflict = true;

    const plan = await prepareOracleRoutineRename(target);

    expect(plan.executable).toBe(false);
    expect(plan.issues.some(({ code }) => code === "target_conflict")).toBe(true);
    expect(api.executeQuery).toHaveBeenCalledWith("conn-1", "APP", expect.stringContaining("'TABLE'"), "APP", undefined, { maxRows: 5001 });
  });

  it("blocks a target name already used by an operator", async () => {
    operatorNamespaceConflict = true;

    const plan = await prepareOracleRoutineRename(target);

    expect(plan.executable).toBe(false);
    expect(plan.issues.some(({ code }) => code === "target_conflict")).toBe(true);
    expect(api.executeQuery).toHaveBeenCalledWith("conn-1", "APP", expect.stringContaining("'OPERATOR'"), "APP", undefined, { maxRows: 5001 });
  });

  it("rechecks namespace and executes a manually corrected caller with the same draft", async () => {
    const original = "CREATE OR REPLACE PROCEDURE APP.CALLER_1 AS BEGIN EXECUTE IMMEDIATE 'BEGIN APP.P_OLD; END;'; END;";
    const corrected = "CREATE OR REPLACE PROCEDURE APP.CALLER_1 AS BEGIN EXECUTE IMMEDIATE 'BEGIN APP.P_NEW; END;'; END;";
    objects.set("PROCEDURE:CALLER_1", { id: "102", source: original });
    vi.mocked(api.rewriteOracleRoutineReferences).mockImplementation(async ({ oldName, newName, source }) => {
      if (/APP\.P_OLD/i.test(source)) throw new Error("Dynamic routine references cannot be rewritten automatically.");
      return source.replaceAll(oldName, newName);
    });
    const plan = await prepareOracleRoutineRename(target, { "PROCEDURE:CALLER_1": corrected });
    expect(plan.executable).toBe(true);
    namespaceConflict = true;

    await expect(executeOracleRoutineRename(plan)).rejects.toThrow(/metadata changed/i);

    expect(objects.has("PROCEDURE:P_NEW")).toBe(false);
    expect(vi.mocked(api.executeQuery).mock.calls.some(([, , sql]) => sql.startsWith("CREATE"))).toBe(false);
    expect(vi.mocked(api.executeQuery).mock.calls.some(([, , sql]) => sql.startsWith("DROP"))).toBe(false);

    namespaceConflict = false;
    await expect(executeOracleRoutineRename(plan)).resolves.toBeUndefined();
    expect(objects.get("PROCEDURE:CALLER_1")?.source).toBe(corrected);
    expect(objects.has("PROCEDURE:P_OLD")).toBe(false);
  });

  it("migrates the direct caller, verifies the two-level graph, then drops the old routine", async () => {
    const plan = await prepareOracleRoutineRename(target);

    await expect(executeOracleRoutineRename(plan)).resolves.toBeUndefined();

    expect(objects.has("PROCEDURE:P_OLD")).toBe(false);
    expect(objects.get("PROCEDURE:P_NEW")?.id).toBe("201");
    expect(objects.get("PROCEDURE:CALLER_1")?.source).toContain("P_NEW");
    expect(objects.get("PROCEDURE:CALLER_2")?.source).toBe(secondCallerSource);
    expect(vi.mocked(api.executeQuery).mock.calls.some(([, , sql]) => sql.startsWith("DROP PROCEDURE"))).toBe(true);
  });

  it("accepts a new object identity after a rewritten caller view is verified", async () => {
    objects.clear();
    objects.set("PROCEDURE:P_OLD", { id: "101", source: rootSource });
    objects.set("VIEW:V_CALL", { id: "150", source: "CREATE OR REPLACE VIEW APP.V_CALL AS SELECT APP.P_OLD() AS RESULT FROM DUAL" });
    dependencyRows = new Map([
      ["PROCEDURE:P_OLD", [["APP", "V_CALL", "VIEW", null]]],
      ["VIEW:V_CALL", []],
    ]);
    const plan = await prepareOracleRoutineRename(target);

    await expect(executeOracleRoutineRename(plan)).resolves.toBeUndefined();

    expect(objects.get("VIEW:V_CALL")?.id).toBe("202");
    expect(objects.get("VIEW:V_CALL")?.source).toContain("P_NEW");
    expect(objects.has("PROCEDURE:P_OLD")).toBe(false);
  });

  it("rejects a rewritten caller view whose CREATE OR REPLACE targets another view", async () => {
    objects.clear();
    objects.set("PROCEDURE:P_OLD", { id: "101", source: rootSource });
    objects.set("VIEW:V_CALL", { id: "150", source: "CREATE OR REPLACE VIEW APP.V_OTHER AS SELECT APP.P_OLD() AS RESULT FROM DUAL" });
    dependencyRows = new Map([
      ["PROCEDURE:P_OLD", [["APP", "V_CALL", "VIEW", null]]],
      ["VIEW:V_CALL", []],
    ]);

    const plan = await prepareOracleRoutineRename(target);

    expect(plan.executable).toBe(false);
    expect(plan.issues.some(({ code, message }) => code === "caller_rewrite_failed" && /declaration does not match/i.test(message))).toBe(true);
    expect(api.reviewOracleViewRenameSource).toHaveBeenCalledWith(expect.objectContaining({ owner: "APP", viewName: "V_CALL", oldName: "P_NEW", newName: "P_NEW" }));
    expect(vi.mocked(api.buildExecutableObjectSourceStatements)).not.toHaveBeenCalledWith(expect.objectContaining({ objectType: "VIEW" }));
  });

  it("rejects a routine caller draft declaring a different object before producing steps", async () => {
    objects.set("PROCEDURE:CALLER_1", { id: "102", source: "CREATE OR REPLACE PROCEDURE OTHER.CALLER_1 AS BEGIN APP.P_OLD; END;" });

    const plan = await prepareOracleRoutineRename(target);

    expect(plan.executable).toBe(false);
    expect(plan.issues.some(({ code, message }) => code === "caller_rewrite_failed" && /declaration does not match/i.test(message))).toBe(true);
    expect(api.validateOracleExecutableObjectSource).toHaveBeenCalledWith(expect.objectContaining({ objectType: "PROCEDURE", schema: "APP", name: "CALLER_1" }));
    expect(plan.steps).toEqual([]);
  });

  it("accepts the database's quoted readback of a planned uppercase caller reference", async () => {
    vi.mocked(api.rewriteOracleRoutineReferences).mockImplementation(async ({ oldName, newName, source }) => source.replaceAll(oldName, `"${newName}"`));
    const plan = await prepareOracleRoutineRename(target);

    await expect(executeOracleRoutineRename(plan)).resolves.toBeUndefined();

    expect(objects.get("PROCEDURE:CALLER_1")?.source).toContain('"P_NEW"');
    expect(objects.has("PROCEDURE:P_OLD")).toBe(false);
  });

  it("executes a manually repaired caller draft after canonical database formatting", async () => {
    canonicalizeCallerReadback = true;
    const corrected = "CREATE OR REPLACE PROCEDURE APP.CALLER_1 IS BEGIN DBMS_OUTPUT.PUT_LINE('keep'); APP.P_OLD; APP.P_OLD; END";
    const plan = await prepareOracleRoutineRename(target, { "PROCEDURE:CALLER_1": corrected });

    expect(plan.executable).toBe(true);
    expect(plan.callers.find((caller) => caller.name === "CALLER_1")?.draft).toBe(corrected);
    expect(plan.steps.some((step) => step.kind === "replace-caller")).toBe(true);

    await expect(executeOracleRoutineRename(plan)).resolves.toBeUndefined();

    expect(objects.get("PROCEDURE:CALLER_1")?.source).toContain("CALLER_1\n IS\nBEGIN");
    expect(objects.has("PROCEDURE:P_OLD")).toBe(false);
    expect(vi.mocked(api.executeQuery).mock.calls.some(([, , sql]) => sql.startsWith("DROP PROCEDURE APP.P_OLD"))).toBe(true);
  });

  it("accepts a one-line root draft when the database reformats its readback", async () => {
    canonicalizeRootReadback = true;
    const correctedRoot = "CREATE OR REPLACE PROCEDURE APP.P_OLD IS BEGIN NULL; END";
    objects.set("PROCEDURE:P_OLD", { id: "101", source: correctedRoot });
    dependencyRows = new Map([["PROCEDURE:P_OLD", []]]);
    const plan = await prepareOracleRoutineRename(target, { "PROCEDURE:P_OLD": correctedRoot });

    await expect(executeOracleRoutineRename(plan)).resolves.toBeUndefined();

    expect(objects.has("PROCEDURE:P_OLD")).toBe(false);
    expect(objects.get("PROCEDURE:P_NEW")?.source).toContain("P_NEW\n IS\nBEGIN");
  });

  it.each(["comment", "string", "call"] as const)("does not drop the old routine after the rewritten caller's %s changes", async (mutation) => {
    mutateCallerBeforeDrop = mutation;
    const corrected = "CREATE OR REPLACE PROCEDURE APP.CALLER_1 IS BEGIN DBMS_OUTPUT.PUT_LINE('keep'); APP.P_OLD; APP.P_OLD; END";
    const plan = await prepareOracleRoutineRename(target, { "PROCEDURE:CALLER_1": corrected });

    await expect(executeOracleRoutineRename(plan)).rejects.toThrow(/CALLER_1 no longer matches the planned rewrite/i);

    expect(objects.has("PROCEDURE:P_OLD")).toBe(true);
    expect(vi.mocked(api.executeQuery).mock.calls.some(([, , sql]) => sql.startsWith("DROP PROCEDURE APP.P_OLD"))).toBe(false);
  });

  it("keeps the original caller snapshot exact when only its whitespace changes after validation", async () => {
    const corrected = "CREATE OR REPLACE PROCEDURE APP.CALLER_1 IS BEGIN APP.P_OLD; APP.P_OLD; END";
    const plan = await prepareOracleRoutineRename(target, { "PROCEDURE:CALLER_1": corrected });
    objects.set("PROCEDURE:CALLER_1", { ...objects.get("PROCEDURE:CALLER_1")!, source: firstCallerSource.replace(" AS BEGIN", " AS\n BEGIN") });

    await expect(executeOracleRoutineRename(plan)).rejects.toThrow(/metadata changed/i);

    expect(objects.has("PROCEDURE:P_NEW")).toBe(false);
    expect(objects.has("PROCEDURE:P_OLD")).toBe(true);
    expect(vi.mocked(api.executeQuery).mock.calls.some(([, , sql]) => sql.startsWith("CREATE OR REPLACE PROCEDURE APP.CALLER_1"))).toBe(false);
    expect(vi.mocked(api.executeQuery).mock.calls.some(([, , sql]) => sql.startsWith("DROP PROCEDURE APP.P_OLD"))).toBe(false);
    expect(vi.mocked(api.executeQuery).mock.calls.some(([, , sql]) => sql.startsWith("CREATE PROCEDURE APP.P_NEW"))).toBe(false);
  });

  it("normalizes database source readback before comparing the new routine definition", async () => {
    objects.set("PROCEDURE:P_OLD", { id: "101", source: rootSource.slice(0, -1) });
    const buildRoutineSource = vi.mocked(api.buildRoutineRenameObjectSourceStatements).getMockImplementation()!;
    vi.mocked(api.buildRoutineRenameObjectSourceStatements).mockImplementation(async (input) => {
      const statements = await buildRoutineSource(input);
      return [statements[0].endsWith(";") ? statements[0] : `${statements[0]};`, statements[1]];
    });

    const plan = await prepareOracleRoutineRename(target);
    await expect(executeOracleRoutineRename(plan)).resolves.toBeUndefined();

    expect(objects.has("PROCEDURE:P_OLD")).toBe(false);
    expect(objects.get("PROCEDURE:P_NEW")?.source).toBe(rootSource.slice(0, -1).replaceAll("P_OLD", "P_NEW"));
  });

  it("stops before replacing callers when the new routine body differs from the approved definition", async () => {
    tamperCreatedOnCreate = true;
    const plan = await prepareOracleRoutineRename(target);

    await expect(executeOracleRoutineRename(plan)).rejects.toMatchObject({ completed: [], uncertain: "P_NEW" });

    expect(objects.has("PROCEDURE:P_OLD")).toBe(true);
    expect(objects.get("PROCEDURE:CALLER_1")?.source).toBe(firstCallerSource);
    expect(vi.mocked(api.executeQuery).mock.calls.some(([, , sql]) => sql.startsWith("DROP PROCEDURE"))).toBe(false);
  });

  it("keeps the old routine when the new object changes after creation", async () => {
    tamperCreatedAfterCaller = true;
    const plan = await prepareOracleRoutineRename(target);

    await expect(executeOracleRoutineRename(plan)).rejects.toBeInstanceOf(OracleRoutineRenameFailure);

    expect(objects.has("PROCEDURE:P_OLD")).toBe(true);
    expect(vi.mocked(api.executeQuery).mock.calls.some(([, , sql]) => sql.startsWith("DROP PROCEDURE"))).toBe(false);
  });

  it("keeps the old routine when the new object identity changes during COMPILE", async () => {
    invalidateCreatedRoot = true;
    tamperCreatedDuringCompile = true;
    const plan = await prepareOracleRoutineRename(target);

    await expect(executeOracleRoutineRename(plan)).rejects.toThrow("changed during compilation");

    expect(objects.has("PROCEDURE:P_OLD")).toBe(true);
    expect(objects.get("PROCEDURE:P_NEW")?.id).toBe("202");
    expect(vi.mocked(api.executeQuery).mock.calls.some(([, , sql]) => sql.startsWith("DROP PROCEDURE"))).toBe(false);
  });

  it("confirms a lost DROP response by reading back the old routine identity", async () => {
    dropErrorAfterDelete = true;
    const plan = await prepareOracleRoutineRename(target);

    await expect(executeOracleRoutineRename(plan)).resolves.toBeUndefined();

    expect(objects.has("PROCEDURE:P_OLD")).toBe(false);
  });

  it("copies and verifies direct EXECUTE grants before dropping the old routine", async () => {
    grants.set("P_OLD", [["APP", "ALICE", "EXECUTE", "NO"]]);
    const plan = await prepareOracleRoutineRename(target);

    expect(plan.steps.map((step) => step.kind)).toEqual(["create", "grant", "replace-caller", "compile-caller", "drop"]);
    await expect(executeOracleRoutineRename(plan)).resolves.toBeUndefined();

    expect(grants.get("P_NEW")).toEqual([["APP", "ALICE", "EXECUTE", "NO"]]);
  });
});
