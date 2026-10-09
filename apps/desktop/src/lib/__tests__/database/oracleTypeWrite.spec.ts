import { describe, expect, it, vi } from "vitest";
import { executeTypeWritePlan, prepareTypeWritePlan, readTypeWriteSnapshot, typeDefinitionSql, type TypeDefinition, type TypeSnapshot, type TypeWriteIO } from "@/lib/database/oracleTypeWrite";
import type { QueryResult } from "@/types/database";

const target = { schema: 'Owner."Q', name: "T.中文" };
const spec = 'CREATE OR REPLACE TYPE "Owner.""Q"."T.中文" AS OBJECT (value VARCHAR2(20));';
const body = 'CREATE OR REPLACE TYPE BODY "Owner.""Q"."T.中文" AS MEMBER FUNCTION value RETURN NUMBER IS BEGIN RETURN 1; END; END;';
const empty = (): TypeSnapshot => ({ definitions: [], references: [] });
const definition = (overrides: Partial<TypeDefinition> = {}): TypeDefinition => ({ kind: "TYPE", source: spec, status: "VALID", objectId: "1", lastDdl: "2026-10-09 10:00:00", ...overrides });
const result = (columns: string[], rows: QueryResult["rows"]): QueryResult => ({ columns, rows, affected_rows: 0, execution_time_ms: 0 });

function ioFor(snapshot: TypeSnapshot) {
  const current = structuredClone(snapshot);
  const io: TypeWriteIO = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM DBA_OBJECTS")) return result(["OBJECT_TYPE", "STATUS", "OBJECT_ID", "LAST_DDL_TIME"], current.definitions.map((item) => [item.kind.replaceAll("_", " "), item.status, item.objectId, item.lastDdl]));
      if (sql.includes("FROM ALL_ERRORS")) return result(["TYPE", "SEQUENCE", "LINE", "POSITION", "TEXT", "ATTRIBUTE"], []);
      if (sql.includes("FROM DBA_DEPENDENCIES")) return result(["OWNER", "NAME", "KIND", "DETAIL"], current.references.map((item) => [item.owner, item.name, item.kind, item.detail]));
      return result([], []);
    }),
    source: vi.fn(async (kind) => current.definitions.find((item) => item.kind === kind)?.source ?? ""),
    execute: vi.fn(async () => result([], [])),
  };
  return { io, current };
}

describe("Oracle type write planning", () => {
  it("preserves quoted identity and uses CREATE without OR REPLACE for a new target", () => {
    expect(typeDefinitionSql(spec, target, "TYPE", false)).toBe(spec.replace(" OR REPLACE", ""));
  });
  it.each(["AS OBJECT (value NUMBER)", "AS TABLE OF VARCHAR2(20)", "AS VARRAY(10) OF NUMBER"])("accepts complete supported specification forms: %s", (form) => {
    expect(typeDefinitionSql(`CREATE TYPE T ${form};`, { schema: "APP", name: "T" }, "TYPE", false)).toBe(`CREATE TYPE "APP"."T" ${form};`);
  });
  it("uses the Oracle PL/SQL splitter for a body with inner semicolons and q-quoted content", () => {
    const source = body.replace("RETURN 1", "RETURN LENGTH(q'[; CREATE TYPE OTHER AS OBJECT(x NUMBER);]')");
    expect(typeDefinitionSql(source, target, "TYPE_BODY", true)).toContain("RETURN LENGTH(q'[");
  });
  it.each([
    spec.replace('"T.中文"', '"OTHER"'),
    spec.replace('"Owner.""Q"', '"OtherOwner"'),
    spec.replace(" AS OBJECT", " FORCE AS OBJECT"),
    `${spec}\nDROP TABLE IMPORTANT;`,
    "CREATE TABLE T (x NUMBER)",
  ])("rejects a mismatched, forced or unrelated definition before dispatch", (source) => {
    expect(() => typeDefinitionSql(source, target, "TYPE", true)).toThrow();
  });
  it("orders the specification before the body", () => {
    const plan = prepareTypeWritePlan("oracle", target, empty(), { TYPE_BODY: body, TYPE: spec });
    expect(plan.steps.map((step) => step.kind)).toEqual(["TYPE", "TYPE_BODY"]);
    expect(plan.steps.every((step) => step.action === "create")).toBe(true);
  });
  it("does not replace an unchanged specification while changing its body", () => {
    const before = { definitions: [definition(), definition({ kind: "TYPE_BODY", source: body, objectId: "2" })], references: [{ owner: "APP", name: "DATA", kind: "TABLE COLUMN", detail: "VALUE" }] };
    const plan = prepareTypeWritePlan("oracle", target, before, { TYPE: spec, TYPE_BODY: body.replace("RETURN 1", "RETURN 2") });
    expect(plan.steps).toHaveLength(1); expect(plan.steps[0].kind).toBe("TYPE_BODY");
  });
  it.each(["TABLE COLUMN", "COLLECTION", "SUBTYPE", "PROCEDURE"])("blocks a specification replacement or drop with %s references", (kind) => {
    const before = { definitions: [definition()], references: [{ owner: "OTHER", name: "DEPENDENT", kind, detail: "X" }] };
    expect(() => prepareTypeWritePlan("oracle", target, before, { TYPE: spec.replace("20", "40") })).toThrow("Incoming dependencies");
    expect(() => prepareTypeWritePlan("oracle", target, before, {}, "TYPE")).toThrow("Incoming dependencies");
  });
  it("never adds FORCE or CASCADE to DROP", () => {
    const plan = prepareTypeWritePlan("oracle", target, { definitions: [definition()], references: [] }, {}, "TYPE");
    expect(plan.steps[0].sql).toBe('DROP TYPE "Owner.""Q"."T.中文"');
  });
  it("does not treat denied dependency metadata as no dependents", async () => {
    const { io } = ioFor(empty());
    vi.mocked(io.query).mockRejectedValue(new Error("ORA-01031"));
    await expect(readTypeWriteSnapshot(io, target)).rejects.toThrow("ORA-01031");
    expect(io.execute).not.toHaveBeenCalled();
  });
});

describe("Oracle type write execution", () => {
  it("refuses a preview whose full source changed", async () => {
    const before = { definitions: [definition()], references: [] };
    const plan = prepareTypeWritePlan("oracle", target, before, { TYPE: spec.replace("20", "40") });
    const { io, current } = ioFor(before);
    current.definitions[0].source = spec.replace("20", "80");
    expect((await executeTypeWritePlan(io, plan)).state).toBe("changed");
    expect(io.execute).not.toHaveBeenCalled();
  });
  it("saves both parts in order and reads their complete sources back", async () => {
    const plan = prepareTypeWritePlan("oceanbase-oracle", target, empty(), { TYPE: spec, TYPE_BODY: body });
    const { io, current } = ioFor(empty());
    vi.mocked(io.execute).mockImplementation(async (sql) => {
      const kind = sql.startsWith("CREATE TYPE BODY") ? "TYPE_BODY" : "TYPE";
      current.definitions.push(definition({ kind, source: sql, objectId: String(current.definitions.length + 1) }));
      return result([], []);
    });
    const actual = await executeTypeWritePlan(io, plan);
    expect(actual.state).toBe("complete"); expect(actual.sent.map((step) => step.kind)).toEqual(["TYPE", "TYPE_BODY"]);
    expect(actual.after?.definitions).toHaveLength(2);
  });
  it("stops after an INVALID specification and keeps the sent statement", async () => {
    const plan = prepareTypeWritePlan("oracle", target, empty(), { TYPE: spec, TYPE_BODY: body });
    const { io, current } = ioFor(empty());
    vi.mocked(io.execute).mockImplementation(async () => { current.definitions.push(definition({ status: "INVALID" })); return result([], []); });
    const actual = await executeTypeWritePlan(io, plan);
    expect(actual.state).toBe("invalid"); expect(actual.sent).toHaveLength(1); expect(io.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["TYPE", "TYPE_BODY"] as const)("does not report complete when another session replaces a VALID %s definition", async (kind) => {
    const before = kind === "TYPE" ? empty() : { definitions: [definition()], references: [] };
    const plan = prepareTypeWritePlan("oracle", target, before, { [kind]: kind === "TYPE" ? spec : body, ...(kind === "TYPE" ? { TYPE_BODY: body } : {}) });
    const { io, current } = ioFor(before);
    vi.mocked(io.execute).mockImplementation(async (sql) => {
      current.definitions.push(definition({ kind, source: kind === "TYPE" ? sql.replace("20", "80") : sql.replace("RETURN 1", "RETURN 9"), objectId: "2" }));
      return result([], []);
    });
    const actual = await executeTypeWritePlan(io, plan);
    expect(actual.state).toBe("changed");
    expect(actual.message).toContain("differs from the sent statement");
    expect(actual.sent).toHaveLength(1);
    expect(io.execute).toHaveBeenCalledTimes(1);
    expect(actual.before).toEqual(before);
    expect(actual.after?.definitions.every((item) => item.status === "VALID")).toBe(true);
  });

  it("verifies the exact type identity while accepting the readback CREATE OR REPLACE prefix", async () => {
    const plan = prepareTypeWritePlan("oracle", target, empty(), { TYPE: spec });
    const { io, current } = ioFor(empty());
    vi.mocked(io.execute).mockImplementation(async () => { current.definitions.push(definition()); return result([], []); });
    expect((await executeTypeWritePlan(io, plan)).state).toBe("complete");
    const wrong = ioFor(empty());
    vi.mocked(wrong.io.execute).mockImplementation(async () => { wrong.current.definitions.push(definition({ source: spec.replace('"T.中文"', '"OTHER"') })); return result([], []); });
    expect((await executeTypeWritePlan(wrong.io, plan)).state).toBe("changed");
  });

  it("detects a specification replaced while its body is being saved", async () => {
    const plan = prepareTypeWritePlan("oracle", target, empty(), { TYPE: spec, TYPE_BODY: body });
    const { io, current } = ioFor(empty());
    vi.mocked(io.execute).mockImplementation(async (sql) => {
      const kind = sql.startsWith("CREATE TYPE BODY") ? "TYPE_BODY" : "TYPE";
      if (kind === "TYPE_BODY") current.definitions[0].source = spec.replace("20", "80");
      current.definitions.push(definition({ kind, source: sql, objectId: String(current.definitions.length + 1) }));
      return result([], []);
    });
    const actual = await executeTypeWritePlan(io, plan);
    expect(actual.state).toBe("changed");
    expect(actual.sent).toHaveLength(2);
    expect(actual.after?.definitions.every((item) => item.status === "VALID")).toBe(true);
  });
  it("keeps original definitions and attempts readback after a failed DDL", async () => {
    const before = { definitions: [definition()], references: [] };
    const plan = prepareTypeWritePlan("oracle", target, before, { TYPE: spec.replace("20", "40") });
    const { io } = ioFor(before);
    vi.mocked(io.execute).mockRejectedValue(new Error("ORA-02303"));
    const actual = await executeTypeWritePlan(io, plan);
    expect(actual).toMatchObject({ state: "failed", before, after: before, message: "ORA-02303" });
    expect(actual.sent).toHaveLength(1);
  });
  it("does not send a write when cancelled before dispatch", async () => {
    const { io } = ioFor(empty()); io.cancelled = () => true;
    const actual = await executeTypeWritePlan(io, prepareTypeWritePlan("oracle", target, empty(), { TYPE: spec }));
    expect(actual.state).toBe("cancelled"); expect(io.execute).not.toHaveBeenCalled();
  });
});
