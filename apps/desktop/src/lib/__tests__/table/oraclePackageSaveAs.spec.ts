import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginSourceSave, captureSourceIdentity } from "@/lib/table/objectSourceIdentity";
import { executeOraclePackageSaveAs, prepareOraclePackageSaveAs } from "@/lib/table/oraclePackageSaveAs";
import { invalidateObjectDdlCache } from "@/lib/metadata/objectDdlCache";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";

const api = vi.hoisted(() => ({ executeQuery: vi.fn(), parseOracleObjectName: vi.fn(), buildExecutableObjectSourceStatements: vi.fn() }));
vi.mock("@/lib/backend/api", () => api);
vi.mock("@/lib/metadata/objectDdlCache", () => ({ invalidateObjectDdlCache: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/table/objectBrowserRowsCache", () => ({ invalidateObjectBrowserRowsCache: vi.fn() }));

const target = { connectionId: "package-save-as", database: "APP", databaseType: "oracle" as const, schema: "APP", oldName: "P_OLD", newName: "P_NEW" };
const spec = "PACKAGE P_OLD AS\n  PROCEDURE RUN;\nEND P_OLD;";
const body = "PACKAGE BODY P_OLD AS\n  PROCEDURE RUN IS BEGIN NULL; END RUN;\nEND P_OLD;";
const result = (rows: unknown[][]) => ({ columns: [], rows, affected_rows: 0, execution_time_ms: 0 });
let sources: Map<string, string>;
let states: Map<string, { id: number; status: string }>;
let failBody: boolean;
let failSpec: boolean;
let failGrant: boolean;
let failFinalReadback: boolean;
let bodyNotCreated: boolean;
let tamperSpecId: boolean;
let operatorTargetConflict: boolean;
let newSpecReads: number;
let grants: Map<string, unknown[][]>;

function key(name: string, type: string) {
  return `${name}:${type}`;
}

function unquote(name: string) {
  return name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name.toUpperCase();
}

beforeEach(() => {
  vi.clearAllMocks();
  sources = new Map([
    [key("P_OLD", "PACKAGE"), spec],
    [key("P_OLD", "PACKAGE BODY"), body],
  ]);
  states = new Map([
    [key("P_OLD", "PACKAGE"), { id: 11, status: "VALID" }],
    [key("P_OLD", "PACKAGE BODY"), { id: 12, status: "VALID" }],
  ]);
  failBody = false;
  failSpec = false;
  failGrant = false;
  failFinalReadback = false;
  bodyNotCreated = false;
  tamperSpecId = false;
  operatorTargetConflict = false;
  newSpecReads = 0;
  grants = new Map([["P_OLD", []]]);
  api.parseOracleObjectName.mockImplementation(async (name) => name.toUpperCase());
  api.buildExecutableObjectSourceStatements.mockImplementation(async ({ source }: { source: string }) => [source]);
  api.executeQuery.mockImplementation(async (_connection: string, _database: string, sql: string) => {
    if (sql.includes("SYS_CONTEXT")) return result([["APP", "APP"]]);
    if (sql.includes("FROM USER_OBJECTS")) {
      const name = /OBJECT_NAME='((?:''|[^'])*)'/.exec(sql)?.[1]?.replaceAll("''", "'") || "";
      const allowedTypes = [...sql.matchAll(/'((?:''|[^'])*)'/g)].map((match) => match[1]?.replaceAll("''", "'") || "");
      const rows = [...states]
        .filter(([objectKey]) => objectKey.startsWith(`${name}:`))
        .filter(([objectKey]) => !allowedTypes.length || allowedTypes.some((type) => objectKey.endsWith(`:${type}`)))
        .map(([objectKey, value]) => {
          const [objectName, objectType] = objectKey.split(":");
          let id = value.id;
          if (tamperSpecId && objectName === "P_NEW" && objectType === "PACKAGE" && ++newSpecReads >= 2) id++;
          return [objectName, objectType, id, value.status];
        });
      if (operatorTargetConflict && name === "P_NEW" && allowedTypes.includes("OPERATOR")) rows.push(["P_NEW", "OPERATOR", 19, "VALID"]);
      return result(rows);
    }
    if (sql.includes("FROM ALL_SOURCE")) {
      const name = /NAME='((?:''|[^'])*)'/.exec(sql)?.[1]?.replaceAll("''", "'") || "";
      const type = /TYPE='((?:''|[^'])*)'/.exec(sql)?.[1] || "";
      const source = sources.get(key(name, type));
      return result(source ? source.split("\n").map((line, index) => [index + 1, line]) : []);
    }
    if (sql.includes("FROM ALL_PROCEDURES")) return result([["RUN", null]]);
    if (sql.includes("FROM ALL_ARGUMENTS")) return result([]);
    if (sql.includes("FROM ALL_TAB_PRIVS")) {
      const name = /TABLE_NAME='((?:''|[^'])*)'/.exec(sql)?.[1]?.replaceAll("''", "'") || "";
      return result(grants.get(name) || []);
    }
    if (sql.includes("FROM USER_ERRORS")) return failFinalReadback && sql.includes("NAME='P_NEW'") ? result([["ERROR", "1", "1", "forced final readback failure"]]) : result([]);
    if (sql.startsWith('CREATE PACKAGE "P_NEW"') && failSpec) throw new Error("spec create failed");
    if (sql.startsWith("CREATE PACKAGE BODY") && failBody) throw new Error("body create failed");
    const create = /^CREATE PACKAGE( BODY)?\s+("(?:[^"]|"")*"|[A-Za-z_$#][\w$#]*)/i.exec(sql);
    if (create) {
      const objectType = create[1] ? "PACKAGE BODY" : "PACKAGE";
      const name = unquote(create[2]!);
      if (bodyNotCreated && objectType === "PACKAGE BODY") throw new Error("unexpected body creation");
      states.set(key(name, objectType), { id: objectType === "PACKAGE" ? 21 : 22, status: "VALID" });
      sources.set(key(name, objectType), sql.replace(/^CREATE\s+/i, "").replace(/;\s*$/, ""));
      return result([]);
    }
    if (sql.startsWith("GRANT EXECUTE")) {
      if (failGrant) throw new Error("grant create failed");
      const objectName = /ON "APP"\."((?:[^"]|"")*)"/i.exec(sql)?.[1]?.replaceAll('""', '"') || "";
      const grantee = / TO ("(?:[^"]|"")*"|PUBLIC)/i.exec(sql)?.[1];
      const rows = grants.get(objectName) || [];
      rows.push(["APP", grantee === "PUBLIC" ? "PUBLIC" : unquote(grantee || ""), "EXECUTE", sql.includes("WITH GRANT OPTION") ? "YES" : "NO"]);
      grants.set(objectName, rows);
      return result([]);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
});

afterEach(() => vi.clearAllMocks());

describe("Oracle package Save As plan and execution", () => {
  it("validates generated spec and body against the executable Oracle source parser", async () => {
    const plan = await prepareOraclePackageSaveAs(target);

    expect(plan.executable).toBe(true);
    expect(api.buildExecutableObjectSourceStatements).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        databaseType: "oracle",
        objectType: "PACKAGE",
        schema: "APP",
        name: "P_NEW",
        source: expect.stringContaining('CREATE PACKAGE "P_NEW"'),
      }),
    );
    expect(api.buildExecutableObjectSourceStatements).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        databaseType: "oracle",
        objectType: "PACKAGE_BODY",
        schema: "APP",
        name: "P_NEW",
        source: expect.stringContaining('CREATE PACKAGE BODY "P_NEW"'),
      }),
    );
  });

  it("reproduces a legal dynamic self-reference that blocks package Save As", async () => {
    const original = "PACKAGE BODY P_OLD AS\n  PROCEDURE RUN IS BEGIN EXECUTE IMMEDIATE 'BEGIN P_OLD.RUN; END;'; END RUN;\nEND P_OLD;";
    sources.set(key("P_OLD", "PACKAGE BODY"), original);

    const plan = await prepareOraclePackageSaveAs(target);

    expect(plan.executable).toBe(false);
    expect(plan.issues.some((issue) => issue.code === "source_rewrite_failed")).toBe(true);
    expect(plan.snapshot?.bodySource).toBe(original);
    expect(plan.statements).toEqual([]);
  });

  it("keeps a variable dynamic SQL body editable and allows a corrected complete literal", async () => {
    const original = "PACKAGE BODY P_OLD AS PROCEDURE RUN IS s VARCHAR2(100) := 'BEGIN P_OLD.RUN; END;'; BEGIN EXECUTE IMMEDIATE s; END RUN; END P_OLD;";
    const corrected = "PACKAGE BODY P_OLD AS PROCEDURE RUN IS BEGIN EXECUTE IMMEDIATE 'BEGIN P_NEW.RUN; END;'; END RUN; END P_OLD;";
    sources.set(key("P_OLD", "PACKAGE BODY"), original);

    const initial = await prepareOraclePackageSaveAs(target);
    expect(initial.executable).toBe(false);
    expect(initial.issues.some((issue) => issue.code === "source_rewrite_failed" && issue.repairable)).toBe(true);
    expect(initial.snapshot?.bodySource).toBe(original);

    const repaired = await prepareOraclePackageSaveAs(target, { body: corrected });
    expect(repaired.executable).toBe(true);
    expect(repaired.bodySource).toContain("EXECUTE IMMEDIATE 'BEGIN P_NEW.RUN; END;'");
  });

  it("preserves a package body rewrite failure and revalidates a manual correction", async () => {
    const original = "PACKAGE BODY P_OLD AS\n  PROCEDURE RUN IS BEGIN EXECUTE IMMEDIATE 'BEGIN P_OLD.RUN; END;'; END RUN;\nEND P_OLD;";
    const corrected = "PACKAGE BODY P_OLD AS\n  PROCEDURE RUN IS BEGIN EXECUTE IMMEDIATE 'BEGIN P_NEW.RUN; END;'; END RUN;\nEND P_OLD;";
    sources.set(key("P_OLD", "PACKAGE BODY"), original);

    const initial = await prepareOraclePackageSaveAs(target);
    expect(initial.executable).toBe(false);
    expect(initial.issues.some((issue) => issue.code === "source_rewrite_failed")).toBe(true);
    expect(initial.snapshot?.bodySource).toBe(original);
    expect(initial.specSource).toContain('CREATE PACKAGE "P_NEW"');

    const repaired = await prepareOraclePackageSaveAs(target, { spec: spec, body: corrected });
    expect(repaired.issues).toEqual([]);
    expect(repaired.executable).toBe(true);
    expect(repaired.bodySource).toContain("P_NEW.RUN");
    expect(repaired.bodySource).toContain('CREATE PACKAGE BODY "P_NEW"');
  });

  it("reads and rewrites package specification and body separately", async () => {
    const plan = await prepareOraclePackageSaveAs(target);
    expect(plan.executable).toBe(true);
    expect(plan.statements).toHaveLength(2);
    expect(plan.statements[0]).toContain('CREATE PACKAGE "P_NEW"');
    expect(plan.statements[1]).toContain('CREATE PACKAGE BODY "P_NEW"');
    expect(plan.statements.join("\n")).not.toMatch(/OR REPLACE/i);
    expect(plan.snapshot?.specSource).toBe(spec);
    expect(plan.snapshot?.bodySource).toBe(body);
  });

  it("rechecks dialog currency after metadata reads and before the first CREATE", async () => {
    const plan = await prepareOraclePackageSaveAs(target);
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    await expect(executeOraclePackageSaveAs(plan, isCurrent)).rejects.toThrow("The Save As dialog changed before package body creation.");
    expect(states.has(key("P_NEW", "PACKAGE"))).toBe(true);
    expect(states.has(key("P_NEW", "PACKAGE BODY"))).toBe(false);
  });

  it("copies a genuinely bodyless package only when both catalogs agree", async () => {
    sources.delete(key("P_OLD", "PACKAGE BODY"));
    states.delete(key("P_OLD", "PACKAGE BODY"));
    const plan = await prepareOraclePackageSaveAs(target);
    expect(plan.executable).toBe(true);
    expect(plan.bodySource).toBeNull();
    expect(plan.statements).toHaveLength(1);

    sources.set(key("P_OLD", "PACKAGE BODY"), body);
    const inconsistent = await prepareOraclePackageSaveAs({ ...target, connectionId: "package-save-as-inconsistent" });
    expect(inconsistent.executable).toBe(false);
    expect(inconsistent.issues.some((issue) => issue.code === "source_read_failed")).toBe(true);
  });

  it("accepts catalog readback with or without the final package terminator", async () => {
    const plan = await prepareOraclePackageSaveAs(target);
    await executeOraclePackageSaveAs(plan);
    for (const type of ["PACKAGE", "PACKAGE BODY"]) {
      const source = sources.get(key("P_NEW", type))!;
      sources.set(key("P_NEW", type), source.replace(/;$/, ""));
    }
    const repeatTarget = { ...target, oldName: "P_NEW", newName: "P_NEW_2" };
    const repeat = await prepareOraclePackageSaveAs(repeatTarget);
    expect(repeat.executable).toBe(true);
    await expect(executeOraclePackageSaveAs(repeat)).resolves.toBeUndefined();
  });

  it("blocks a target name already used by an operator", async () => {
    operatorTargetConflict = true;
    const plan = await prepareOraclePackageSaveAs(target);
    expect(plan.executable).toBe(false);
    expect(plan.issues.some((issue) => issue.code === "target_conflict")).toBe(true);
  });

  it("rechecks namespace and executes a manually corrected body with the same draft", async () => {
    const original = "PACKAGE BODY P_OLD AS\n  PROCEDURE RUN IS BEGIN EXECUTE IMMEDIATE 'BEGIN P_OLD.RUN; END;'; END RUN;\nEND P_OLD;";
    const corrected = "PACKAGE BODY P_OLD AS\n  PROCEDURE RUN IS BEGIN EXECUTE IMMEDIATE 'BEGIN P_NEW.RUN; END;'; END RUN;\nEND P_OLD;";
    sources.set(key("P_OLD", "PACKAGE BODY"), original);
    const plan = await prepareOraclePackageSaveAs(target, { body: corrected });
    expect(plan.executable).toBe(true);
    operatorTargetConflict = true;

    await expect(executeOraclePackageSaveAs(plan)).rejects.toThrow(/changed/i);

    expect(states.has(key("P_NEW", "PACKAGE"))).toBe(false);
    expect(states.has(key("P_NEW", "PACKAGE BODY"))).toBe(false);

    operatorTargetConflict = false;
    await expect(executeOraclePackageSaveAs(plan)).resolves.toBeUndefined();
    expect(sources.get(key("P_NEW", "PACKAGE BODY"))).toContain("P_NEW.RUN");
  });

  it("copies direct EXECUTE grants and verifies the new package", async () => {
    grants.set("P_OLD", [["APP", "PUBLIC", "EXECUTE", "NO"]]);
    const plan = await prepareOraclePackageSaveAs(target);
    const oldSpecIdentity = captureSourceIdentity({ connectionId: target.connectionId, database: target.database, schema: target.schema, objectType: "PACKAGE", name: target.oldName });
    const oldBodyIdentity = captureSourceIdentity({ connectionId: target.connectionId, database: target.database, schema: target.schema, objectType: "PACKAGE_BODY", name: target.oldName });
    expect(plan.statements[plan.statements.length - 1]).toContain('GRANT EXECUTE ON "APP"."P_NEW" TO PUBLIC');
    await executeOraclePackageSaveAs(plan);
    expect(states.get(key("P_OLD", "PACKAGE"))?.id).toBe(11);
    expect(states.has(key("P_NEW", "PACKAGE"))).toBe(true);
    expect(states.has(key("P_NEW", "PACKAGE BODY"))).toBe(true);
    expect(captureSourceIdentity(oldSpecIdentity).revision).toBe(oldSpecIdentity.revision);
    expect(captureSourceIdentity(oldBodyIdentity).revision).toBe(oldBodyIdentity.revision);
  });

  it("uses the canonical target name when reading package compile errors", async () => {
    const plan = await prepareOraclePackageSaveAs({ ...target, newName: "p_new" });
    const implementation = api.executeQuery.getMockImplementation()!;
    const errorQueries: string[] = [];
    api.executeQuery.mockImplementation(async (...args) => {
      if (String(args[2]).includes("FROM USER_ERRORS")) errorQueries.push(String(args[2]));
      return implementation(...args);
    });
    await executeOraclePackageSaveAs(plan);
    expect(errorQueries.length).toBeGreaterThan(0);
    expect(errorQueries.every((sql) => sql.includes("NAME='P_NEW'"))).toBe(true);
  });

  it("keeps a created specification as an explicit partial result when body creation fails and releases both source locks", async () => {
    const plan = await prepareOraclePackageSaveAs(target);
    const oldSpecIdentity = captureSourceIdentity({ connectionId: target.connectionId, database: target.database, schema: target.schema, objectType: "PACKAGE", name: target.oldName });
    const oldBodyIdentity = captureSourceIdentity({ connectionId: target.connectionId, database: target.database, schema: target.schema, objectType: "PACKAGE_BODY", name: target.oldName });
    failBody = true;
    await expect(executeOraclePackageSaveAs(plan)).rejects.toMatchObject({ completed: ["PACKAGE P_NEW"], uncertain: "PACKAGE BODY P_NEW" });
    expect(states.has(key("P_NEW", "PACKAGE"))).toBe(true);
    expect(states.has(key("P_NEW", "PACKAGE BODY"))).toBe(false);
    for (const objectType of ["PACKAGE", "PACKAGE_BODY"]) {
      const snapshot = captureSourceIdentity({ connectionId: target.connectionId, database: target.database, schema: target.schema, objectType, name: target.oldName });
      const release = beginSourceSave(snapshot);
      release();
    }
    expect(captureSourceIdentity(oldSpecIdentity).revision).toBe(oldSpecIdentity.revision);
    expect(captureSourceIdentity(oldBodyIdentity).revision).toBe(oldBodyIdentity.revision);
    expect(invalidateObjectBrowserRowsCache).toHaveBeenCalledWith({ connectionId: target.connectionId, database: target.database, schema: target.schema });
    expect(invalidateObjectDdlCache).toHaveBeenCalledTimes(2);
  });

  it("invalidates both caches when the first specification DDL has an unknown outcome", async () => {
    const plan = await prepareOraclePackageSaveAs(target);
    failSpec = true;
    await expect(executeOraclePackageSaveAs(plan)).rejects.toMatchObject({ completed: [], uncertain: "PACKAGE P_NEW", dispatched: true });
    expect(invalidateObjectBrowserRowsCache).toHaveBeenCalledOnce();
    expect(invalidateObjectDdlCache).toHaveBeenCalledTimes(2);
  });

  it("invalidates both caches after grant or final readback failure", async () => {
    grants.set("P_OLD", [["APP", "PUBLIC", "EXECUTE", "NO"]]);
    const grantPlan = await prepareOraclePackageSaveAs(target);
    failGrant = true;
    await expect(executeOraclePackageSaveAs(grantPlan)).rejects.toMatchObject({ completed: ["PACKAGE P_NEW", "PACKAGE BODY P_NEW"], dispatched: true });
    expect(invalidateObjectBrowserRowsCache).toHaveBeenCalledOnce();
    expect(invalidateObjectDdlCache).toHaveBeenCalledTimes(2);

    failGrant = false;
    states.delete(key("P_NEW", "PACKAGE"));
    states.delete(key("P_NEW", "PACKAGE BODY"));
    sources.delete(key("P_NEW", "PACKAGE"));
    sources.delete(key("P_NEW", "PACKAGE BODY"));
    vi.clearAllMocks();
    const finalPlan = await prepareOraclePackageSaveAs(target);
    failFinalReadback = true;
    await expect(executeOraclePackageSaveAs(finalPlan)).rejects.toMatchObject({ dispatched: true });
    expect(invalidateObjectBrowserRowsCache).toHaveBeenCalledOnce();
    expect(invalidateObjectDdlCache).toHaveBeenCalledTimes(2);
  });

  it("requires preview identity to remain current before dispatch", async () => {
    const plan = await prepareOraclePackageSaveAs(target);
    await expect(executeOraclePackageSaveAs(plan, () => false)).rejects.toThrow(/target changed/i);
    expect(states.has(key("P_NEW", "PACKAGE"))).toBe(false);
    expect(invalidateObjectBrowserRowsCache).not.toHaveBeenCalled();
    expect(invalidateObjectDdlCache).not.toHaveBeenCalled();
  });

  it("does not create the body if the new specification identity changes after its creation", async () => {
    const plan = await prepareOraclePackageSaveAs(target);
    tamperSpecId = true;
    await expect(executeOraclePackageSaveAs(plan)).rejects.toMatchObject({ completed: ["PACKAGE P_NEW"], uncertain: "PACKAGE P_NEW" });
    expect(states.has(key("P_NEW", "PACKAGE BODY"))).toBe(false);
  });
});
