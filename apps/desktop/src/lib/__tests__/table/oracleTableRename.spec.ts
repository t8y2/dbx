import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeOracleTableRename, OracleTableRenameFailure, prepareOracleTableRename } from "@/lib/table/oracleTableRename";
import { assertSourceIdentity, captureSourceIdentity } from "@/lib/table/objectSourceIdentity";

const api = vi.hoisted(() => ({ executeQuery: vi.fn(), parseOracleObjectName: vi.fn(), rewriteOracleTableReferences: vi.fn(), reviewOracleViewRenameSource: vi.fn() }));
vi.mock("@/lib/backend/api", () => api);

const target = { connectionId: "c", database: "OWNER", databaseType: "oceanbase-oracle" as const, schema: "OWNER", oldName: "OLD", newName: "NEW" };
const result = (rows: unknown[][]) => ({ columns: [], rows, affected_rows: 0, execution_time_ms: 0 });

interface FixtureObject {
  type: string;
  id: string;
  status: string;
  source: string;
  grant: string;
  error: string;
  triggerStatus?: string;
  triggerTable?: string;
}

let objects: Map<string, FixtureObject>;
let edges: unknown[][];
let statements: string[];
let nextId: number;
let targetConflict: string | false;
let loseRenameReply: boolean;
let failRenameReadbackOnRename: boolean;
let unknownRenameReadback: boolean;
let reuseOldNameAfterRename: boolean;
let driftGraphAfterRename: boolean;
let driftGraphAfterFirstRebuild: boolean;
let tamperCompletedViewAfterLaterRebuild: boolean;
let tamperInvalidViewAfterRename: boolean;
let tableIndexRows: unknown[][];
let tableConstraintRows: unknown[][];
let incomingForeignKeyRows: unknown[][];
let boundTriggerRows: unknown[][];
let driftTableMetadataAfterRename: boolean;
let referenceEdges: Map<string, unknown[][]>;
let enforceOracleColumnGrantOwnerColumn: boolean;
let columnGrantRows: unknown[][];

function key(type: string, name: string) {
  return `${type}:${name}`;
}

function fixture() {
  objects = new Map([
    [key("TABLE", "OLD"), { type: "TABLE", id: "1", status: "VALID", source: "", grant: "[]", error: "[]" }],
    [key("VIEW", "DEP"), { type: "VIEW", id: "2", status: "VALID", source: "CREATE VIEW DEP AS SELECT ID FROM OLD", grant: "[]", error: "[]" }],
    [key("PROCEDURE", "P1"), { type: "PROCEDURE", id: "3", status: "VALID", source: "CREATE PROCEDURE P1 AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM OLD; END;", grant: "[]", error: "[]" }],
  ]);
  edges = [
    ["OWNER", "DEP", "VIEW", null],
    ["OWNER", "P1", "PROCEDURE", null],
  ];
  statements = [];
  nextId = 10;
  targetConflict = false;
  loseRenameReply = false;
  failRenameReadbackOnRename = false;
  unknownRenameReadback = false;
  reuseOldNameAfterRename = false;
  driftGraphAfterRename = false;
  driftGraphAfterFirstRebuild = false;
  tamperCompletedViewAfterLaterRebuild = false;
  tamperInvalidViewAfterRename = false;
  tableIndexRows = [];
  tableConstraintRows = [];
  incomingForeignKeyRows = [];
  boundTriggerRows = [];
  driftTableMetadataAfterRename = false;
  referenceEdges = new Map();
  enforceOracleColumnGrantOwnerColumn = false;
  columnGrantRows = [];
  api.parseOracleObjectName.mockImplementation(async (name: string) => name.toUpperCase());
  api.reviewOracleViewRenameSource.mockImplementation(async ({ source, owner, viewName, oldName, newName, targetViewName }: { source: string; owner: string; viewName: string; oldName: string; newName: string; targetViewName?: string }) => {
    const output = (oldName === newName ? source : source.replaceAll(new RegExp(`\\b${oldName}\\b`, "g"), `"${newName}"`)).replace(`VIEW ${viewName}`, `VIEW ${targetViewName || viewName}`);
    const references = [...source.matchAll(/\bFROM\s+"?([A-Z][A-Z0-9_$#]*)"?/gi)].map((match) => ({ owner, name: match[1] }));
    return { source: { source: output, fingerprint: output, references }, references, issues: [] };
  });
  api.rewriteOracleTableReferences.mockImplementation(async ({ source, oldName, newName }: { source: string; oldName: string; newName: string }) => {
    if (/EXECUTE\s+IMMEDIATE/i.test(source)) throw new Error("Dynamic SQL is outside the supported table-reference subset.");
    return source.replaceAll(new RegExp(`"?\\b${oldName}\\b"?`, "g"), `"${newName}"`);
  });
  api.executeQuery.mockImplementation(async (_connection: string, _database: string, sql: string) => {
    statements.push(sql);
    if (sql.includes("SYS_CONTEXT")) return result([["OWNER", "OWNER"]]);
    if (sql.includes("DEPENDENCIES")) {
      if (driftGraphAfterRename && sql.includes("REFERENCED_NAME='NEW'")) return result([["OWNER", "LATE", "VIEW", null]]);
      const reference = /REFERENCED_NAME='([^']+)'/.exec(sql)?.[1];
      const type = /REFERENCED_TYPE='([^']+)'/.exec(sql)?.[1];
      if (unknownRenameReadback && (reference === "NEW" || reference === "OLD")) throw new Error("readback unavailable");
      if (reference === "OLD" && type === "TABLE") return result(objects.has(key("TABLE", "OLD")) ? edges : []);
      if (reference === "NEW" && type === "TABLE") return result(objects.has(key("TABLE", "NEW")) ? edges : []);
      return result(referenceEdges.get(key(type || "", reference || "")) || []);
    }
    if (sql.includes("ALL_COL_PRIVS")) {
      if (enforceOracleColumnGrantOwnerColumn && /\bOWNER\s*=/i.test(sql)) return { ...result([]), execution_error: true, error: 'ORA-00904: "OWNER": invalid identifier' };
      return result(/\b(?:OWNER|TABLE_SCHEMA)\s*=/i.test(sql) ? columnGrantRows : []);
    }
    if (sql.includes("ALL_TAB_PRIVS")) return result([]);
    if (sql.includes("USER_ERRORS")) return result([]);
    if (sql.includes("USER_TRIGGERS")) {
      if (sql.includes("TABLE_NAME=")) {
        return result(boundTriggerRows);
      }
      const name = /TRIGGER_NAME='([^']+)'/.exec(sql)?.[1];
      const trigger = objects.get(key("TRIGGER", name || ""));
      return trigger ? result([[trigger.triggerStatus, trigger.triggerTable]]) : result([]);
    }
    if (sql.includes("USER_INDEXES")) return result(tableIndexRows);
    if (sql.includes("USER_CONSTRAINTS")) return result(tableConstraintRows);
    if (sql.includes("ALL_CONSTRAINTS")) return result(incomingForeignKeyRows);
    if (sql.includes("USER_IND_COLUMNS") || sql.includes("USER_CONS_COLUMNS")) return result([]);
    if (sql.includes("USER_OBJECTS")) {
      const name = /OBJECT_NAME='([^']+)'/.exec(sql)?.[1];
      if (unknownRenameReadback && (name === "NEW" || name === "OLD")) throw new Error("readback unavailable");
      const types = [...sql.matchAll(/'([A-Z ]+)'/g)].map((match) => match[1]);
      if (name === "NEW" && targetConflict && types.includes(targetConflict)) return result([[targetConflict, "99", "VALID"]]);
      const found = [...objects.values()].filter((object) => object.type && objects.get(key(object.type, name || "")) === object && (!types.length || types.includes(object.type)));
      return result(found.map((object) => [object.type, object.id, object.status]));
    }
    if (sql.includes("DBMS_LOB.GETLENGTH") || sql.includes("DBMS_LOB.SUBSTR")) {
      const name = /GET_DDL\('[A-Z ]+','([^']+)'/.exec(sql)?.[1];
      const object = [...objects.values()].find((item) => objects.get(key(item.type, name || "")) === item);
      const source = object?.source || `CREATE TABLE ${name} (ID NUMBER)`;
      if (sql.includes("GETLENGTH")) return result([[Array.from(source).length]]);
      const offsets = [...sql.matchAll(/SELECT (\d+) CHUNK_OFFSET/g)].map((match) => Number(match[1]));
      const chars = Array.from(source);
      return result(offsets.map((offset) => [offset, chars.slice(offset - 1, offset - 1 + 1000).join("")]));
    }
    if (sql.startsWith("RENAME")) {
      const oldTable = objects.get(key("TABLE", "OLD"))!;
      objects.delete(key("TABLE", "OLD"));
      objects.set(key("TABLE", "NEW"), oldTable);
      if (reuseOldNameAfterRename) objects.set(key("VIEW", "OLD"), { type: "VIEW", id: "88", status: "VALID", source: "CREATE VIEW OLD AS SELECT 1 ID FROM DUAL", grant: "[]", error: "[]" });
      for (const object of objects.values()) if (object.type === "VIEW") object.status = "INVALID";
      if (tamperInvalidViewAfterRename) {
        objects.get(key("VIEW", "DEP"))!.source = "CREATE VIEW DEP AS SELECT ID FROM OTHER";
        tamperInvalidViewAfterRename = false;
      }
      for (const object of objects.values()) {
        if (object.type !== "TRIGGER") continue;
        object.triggerTable = "NEW";
        object.source = object.source.replace(/\bON\s+OLD\b/i, "ON NEW");
      }
      if (driftGraphAfterRename) edges.push(["OWNER", "LATE", "VIEW", null]);
      if (driftTableMetadataAfterRename) tableIndexRows.push(["IDX_OLD", "NORMAL", "UNIQUE", "UNUSABLE", null]);
      if (failRenameReadbackOnRename) unknownRenameReadback = true;
      if (loseRenameReply) throw new Error("response lost");
      return result([]);
    }
    if (/\bCREATE(?: OR REPLACE)?\s+(?:VIEW|PROCEDURE|FUNCTION|TRIGGER)\b/i.test(sql)) {
      const declarationStart = sql.search(/\bCREATE(?: OR REPLACE)?\s+(?:VIEW|PROCEDURE|FUNCTION|TRIGGER)\b/i);
      const match = declarationStart < 0 ? null : /^CREATE(?: OR REPLACE)? (VIEW|PROCEDURE|FUNCTION|TRIGGER) (?:"OWNER"\.)?"?([A-Z0-9_$#]+)"?/i.exec(sql.slice(declarationStart));
      if (!match) throw new Error(`Unexpected DDL: ${sql}`);
      const [, type, name] = match;
      const prior = objects.get(key(type.toUpperCase(), name));
      const objectType = type.toUpperCase();
      const triggerStatus = prior?.triggerStatus || "ENABLED";
      const triggerTable = objectType === "TRIGGER" ? /\bON\s+"?([A-Z0-9_$#]+)"?/i.exec(sql)?.[1] : undefined;
      const stateClause = triggerStatus === "DISABLED" ? "DISABLE" : "ENABLE";
      const storedSource = objectType === "TRIGGER" ? `${sql}\nALTER TRIGGER OWNER.${name} ${stateClause};` : sql;
      objects.set(key(objectType, name), { type: objectType, id: objectType === "VIEW" ? String(nextId++) : prior?.id || String(nextId++), status: "VALID", source: storedSource, grant: prior?.grant || "[]", error: "[]", ...(objectType === "TRIGGER" ? { triggerStatus, triggerTable } : {}) });
      if (objectType === "VIEW" && tamperCompletedViewAfterLaterRebuild) {
        const procedure = objects.get(key("PROCEDURE", "P1"));
        if (procedure) procedure.source = procedure.source.replace('FROM "NEW"', 'FROM "OTHER"');
        tamperCompletedViewAfterLaterRebuild = false;
      }
      if (driftGraphAfterFirstRebuild) {
        driftGraphAfterFirstRebuild = false;
        edges.push(["OWNER", "LATE", "VIEW", null]);
      }
      return result([]);
    }
    if (sql.startsWith("ALTER PROCEDURE") || sql.startsWith("ALTER FUNCTION") || sql.startsWith("ALTER VIEW")) {
      const name = /"([A-Z0-9_$#]+)"\s+COMPILE/i.exec(sql)?.[1];
      const type = /^ALTER\s+(PROCEDURE|FUNCTION|VIEW)/i.exec(sql)?.[1]?.toUpperCase();
      const object = type && name ? objects.get(key(type, name)) : undefined;
      if (object) object.status = "VALID";
      return result([]);
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
}

function mockInvalidViewSource() {
  api.reviewOracleViewRenameSource.mockImplementation(async ({ source, owner, oldName, newName }: { source: string; owner: string; oldName: string; newName: string }) => {
    if (source.includes("SELECT FROM")) return { source: null, references: [], issues: [{ code: "invalid_definition", message: "invalid view definition", repairable: true }] };
    const references = [...source.matchAll(/\bFROM\s+"?([A-Z][A-Z0-9_$#]*)"?/gi)].map((match) => ({ owner, name: match[1] }));
    const rewritten = oldName === newName ? source : source.replaceAll(new RegExp(`\\b${oldName}\\b`, "g"), `"${newName}"`);
    return { source: { source: rewritten, fingerprint: rewritten, references }, references, issues: [] };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture();
});

describe("Oracle table rename plan", () => {
  it("reads native Oracle column grants through TABLE_SCHEMA", async () => {
    enforceOracleColumnGrantOwnerColumn = true;
    columnGrantRows = [["OWNER", "ALICE", "ID", "SELECT", "NO"]];

    const plan = await prepareOracleTableRename({ ...target, databaseType: "oracle" });

    expect(plan.executable).toBe(true);
    const grants = JSON.parse(plan.tableSnapshot!.grants) as unknown[][];
    expect(JSON.parse(String(grants[1]![0]))).toEqual(columnGrantRows[0]);
  });

  it("retains the OceanBase Oracle OWNER dictionary column", async () => {
    columnGrantRows = [["OWNER", "ALICE", "ID", "SELECT", "NO"]];

    const plan = await prepareOracleTableRename(target);

    expect(plan.executable).toBe(true);
    const grants = JSON.parse(plan.tableSnapshot!.grants) as unknown[][];
    expect(JSON.parse(String(grants[1]![0]))).toEqual(columnGrantRows[0]);
    expect(api.executeQuery).toHaveBeenCalledWith("c", "OWNER", expect.stringContaining("ALL_COL_PRIVS WHERE OWNER='OWNER'"), "OWNER", undefined, { maxRows: 5001 });
  });

  it("rejects a target namespace conflict before producing executable DDL", async () => {
    targetConflict = "VIEW";
    const plan = await prepareOracleTableRename(target);
    expect(plan.executable).toBe(false);
    expect(plan.issues.some((item) => item.code === "target_conflict")).toBe(true);
    expect(plan.steps).toEqual([]);
  });

  it("rechecks root indexes captured in the preview before renaming", async () => {
    tableIndexRows = [["IDX_OLD", "NORMAL", "UNIQUE", "VALID", null]];
    const plan = await prepareOracleTableRename(target);
    tableIndexRows = [["IDX_OLD", "NORMAL", "UNIQUE", "UNUSABLE", null]];

    await expect(executeOracleTableRename(plan)).rejects.toThrow("Table metadata changed");
    expect(statements.some((sql) => sql.startsWith("RENAME"))).toBe(false);
  });

  it("includes triggers bound to the table even when the dependency view omits them", async () => {
    objects.set(key("TRIGGER", "TR_ONLY"), {
      type: "TRIGGER",
      id: "4",
      status: "VALID",
      triggerStatus: "ENABLED",
      triggerTable: "OLD",
      source: "CREATE OR REPLACE TRIGGER TR_ONLY BEFORE INSERT ON OLD FOR EACH ROW BEGIN NULL; END;\nALTER TRIGGER OWNER.TR_ONLY ENABLE;",
      grant: "[]",
      error: "[]",
    });
    boundTriggerRows = [["TR_ONLY", "ENABLED"]];
    const plan = await prepareOracleTableRename(target);

    expect(plan.executable).toBe(true);
    expect(plan.dependents.some((dependent) => dependent.name === "TR_ONLY" && dependent.objectType === "TRIGGER")).toBe(true);
  });

  it("allows a trigger with the same target name because triggers use a separate namespace", async () => {
    targetConflict = "TRIGGER";
    const plan = await prepareOracleTableRename(target);
    expect(plan.executable).toBe(true);
    expect(plan.issues.some((item) => item.code === "target_conflict")).toBe(false);
  });

  it("lists unsupported dependencies and keeps the rename unexecutable", async () => {
    edges.push(["OWNER", "PKG", "PACKAGE", null]);
    const plan = await prepareOracleTableRename(target);
    expect(plan.executable).toBe(false);
    expect(plan.issues.some((item) => item.code === "unsupported_dependency" && item.objectName === "PKG")).toBe(true);
    expect(statements.some((sql) => sql.startsWith("RENAME"))).toBe(false);
  });

  it("keeps an unsupported source editable and enables execution after a corrected draft is revalidated", async () => {
    edges = [["OWNER", "P1", "PROCEDURE", null]];
    objects.delete(key("VIEW", "DEP"));
    objects.get(key("PROCEDURE", "P1"))!.source = "CREATE PROCEDURE P1 AS BEGIN EXECUTE IMMEDIATE 'SELECT * FROM OLD'; END;";
    const initial = await prepareOracleTableRename(target);
    expect(initial.executable).toBe(false);
    expect(initial.issues.some((item) => item.code === "source_rewrite_failed" && item.objectName === "P1" && item.repairable)).toBe(true);

    const corrected = await prepareOracleTableRename(target, {
      P1: "CREATE PROCEDURE P1 AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM OLD; END;",
    });
    expect(corrected.issues).toEqual([]);
    expect(corrected.executable).toBe(true);
    expect(corrected.steps.map((step) => step.objectName)).toEqual(["OLD", "P1"]);
    await expect(executeOracleTableRename(corrected, { P1: corrected.dependents[0].draft })).resolves.toBeUndefined();
    expect(objects.get(key("PROCEDURE", "P1"))?.source).toContain('FROM "NEW"');
  });

  it("allows a manually corrected dependent view when its original definition cannot be parsed", async () => {
    edges = [["OWNER", "DEP", "VIEW", null]];
    objects.delete(key("PROCEDURE", "P1"));
    objects.get(key("VIEW", "DEP"))!.source = "CREATE VIEW DEP AS SELECT FROM OLD";
    mockInvalidViewSource();

    const initial = await prepareOracleTableRename(target);
    expect(initial.executable).toBe(false);
    expect(initial.issues.some((item) => item.code === "source_rewrite_failed" && item.objectName === "DEP")).toBe(true);

    const corrected = await prepareOracleTableRename(target, { DEP: "CREATE VIEW DEP AS SELECT ID FROM OLD" });
    expect(corrected.executable, JSON.stringify(corrected.issues)).toBe(true);
    expect(corrected.issues).toEqual([]);
    expect(corrected.steps.at(-1)?.sql).toContain('FROM "NEW"');
    await expect(executeOracleTableRename(corrected, { DEP: "CREATE VIEW DEP AS SELECT ID FROM OLD" })).resolves.toBeUndefined();
    expect(objects.get(key("VIEW", "DEP"))?.source).toContain('FROM "NEW"');
  });

  it("rejects a corrected view draft that removes a dependency from the planned graph", async () => {
    edges = [["OWNER", "DEP", "VIEW", null]];
    objects.delete(key("PROCEDURE", "P1"));
    objects.get(key("VIEW", "DEP"))!.source = "CREATE VIEW DEP AS SELECT FROM OLD";
    mockInvalidViewSource();

    const plan = await prepareOracleTableRename(target, { DEP: "CREATE VIEW DEP AS SELECT ID FROM DUAL" });
    expect(plan.executable).toBe(false);
    expect(
      plan.issues.some((item) => item.code === "manual_graph" && item.objectName === "DEP"),
      JSON.stringify({ issues: plan.issues, calls: api.reviewOracleViewRenameSource.mock.calls }),
    ).toBe(true);
    expect(plan.steps).toEqual([]);
  });

  it("keeps an incomplete external dependency graph blocking a corrected view draft", async () => {
    edges = [["OWNER", "DEP", "VIEW", null]];
    objects.delete(key("PROCEDURE", "P1"));
    objects.get(key("VIEW", "DEP"))!.source = "CREATE VIEW DEP AS SELECT FROM OLD";
    referenceEdges.set(key("VIEW", "DEP"), [["REMOTE_OWNER", "REMOTE_VIEW", "VIEW", null]]);
    mockInvalidViewSource();

    const plan = await prepareOracleTableRename(target, { DEP: "CREATE VIEW DEP AS SELECT ID FROM OLD" });
    expect(plan.executable).toBe(false);
    expect(plan.issues.some((item) => item.code === "unsupported_dependency")).toBe(true);
    expect(plan.steps).toEqual([]);
  });

  it("requires exact original-source equality when the invalid view has no fingerprint", async () => {
    edges = [["OWNER", "DEP", "VIEW", null]];
    objects.delete(key("PROCEDURE", "P1"));
    objects.get(key("VIEW", "DEP"))!.source = "CREATE VIEW DEP AS SELECT FROM OLD";
    mockInvalidViewSource();
    const plan = await prepareOracleTableRename(target, { DEP: "CREATE VIEW DEP AS SELECT ID FROM OLD" });
    expect(plan.executable).toBe(true);
    tamperInvalidViewAfterRename = true;

    await expect(executeOracleTableRename(plan, { DEP: "CREATE VIEW DEP AS SELECT ID FROM OLD" })).rejects.toBeInstanceOf(OracleTableRenameFailure);
    expect(statements.filter((sql) => sql.startsWith("RENAME"))).toHaveLength(1);
    expect(statements.filter((sql) => sql.startsWith("CREATE VIEW"))).toHaveLength(0);
  });

  it("does not treat a corrected indirect view draft as applied by COMPILE", async () => {
    edges = [["OWNER", "DEP", "VIEW", null]];
    objects.delete(key("PROCEDURE", "P1"));
    objects.get(key("VIEW", "DEP"))!.source = "CREATE VIEW DEP AS SELECT FROM OLD";
    objects.set(key("VIEW", "DEP2"), { type: "VIEW", id: "4", status: "VALID", source: "CREATE VIEW DEP2 AS SELECT FROM", grant: "[]", error: "[]" });
    referenceEdges.set(key("VIEW", "DEP"), [["OWNER", "DEP2", "VIEW", null]]);
    mockInvalidViewSource();

    const plan = await prepareOracleTableRename(target, { DEP: "CREATE VIEW DEP AS SELECT ID FROM OLD", DEP2: "CREATE VIEW DEP2 AS SELECT ID FROM DEP" });

    expect(plan.executable).toBe(false);
    expect(plan.issues.some((item) => item.code === "source_rewrite_failed" && item.objectName === "DEP2")).toBe(true);
    expect(plan.steps).toEqual([]);
  });

  it.each([
    ["another object", "CREATE OR REPLACE PROCEDURE OWNER.P_OTHER AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM OLD; END;"],
    ["an appended statement", "CREATE OR REPLACE PROCEDURE P1 AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM OLD; END; CREATE OR REPLACE PROCEDURE P_OTHER AS BEGIN NULL; END;"],
    ["a trailing DDL hidden before a second block", "CREATE OR REPLACE PROCEDURE P1 AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM OLD; END; DROP TABLE VICTIM; BEGIN NULL; END;"],
  ])("rejects a draft that declares %s before any DDL is sent", async (_label, source) => {
    edges = [["OWNER", "P1", "PROCEDURE", null]];
    objects.delete(key("VIEW", "DEP"));
    const plan = await prepareOracleTableRename(target, { P1: source });

    expect(plan.executable).toBe(false);
    expect(plan.issues.some((item) => item.code === "source_rewrite_failed" && item.objectName === "P1")).toBe(true);
    expect(statements.some((sql) => sql.startsWith("RENAME"))).toBe(false);
  });

  it("rejects a direct routine draft that adds a new table dependency", async () => {
    edges = [["OWNER", "P1", "PROCEDURE", null]];
    objects.delete(key("VIEW", "DEP"));
    const draft = "CREATE OR REPLACE PROCEDURE P1 AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM OLD; SELECT COUNT(*) INTO n FROM OTHER_TABLE; END;";
    const plan = await prepareOracleTableRename(target, { P1: draft });

    expect(plan.executable).toBe(false);
    expect(plan.issues.some((item) => item.message.includes("adds U:OTHER_TABLE"))).toBe(true);
    expect(statements.some((sql) => sql.startsWith("RENAME"))).toBe(false);
  });

  it.each([
    ["routine calls", "SELECT Q() INTO n FROM OLD"],
    ["type references", "DECLARE v OTHER_T.col%TYPE; BEGIN SELECT COUNT(*) INTO n FROM OLD"],
    ["case-sensitive quoted tables", 'SELECT COUNT(*) INTO n FROM OLD; SELECT COUNT(*) INTO n FROM "OTHER"'],
  ])("rejects a draft that changes %s", async (_label, additionalSource) => {
    edges = [["OWNER", "P1", "PROCEDURE", null]];
    objects.delete(key("VIEW", "DEP"));
    const original = "CREATE OR REPLACE PROCEDURE P1 AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM OLD; END;";
    objects.get(key("PROCEDURE", "P1"))!.source = original;
    const draft = `CREATE OR REPLACE PROCEDURE P1 AS n NUMBER; BEGIN ${additionalSource}; END;`;
    const plan = await prepareOracleTableRename(target, { P1: draft });

    expect(plan.executable).toBe(false);
    expect(plan.issues.some((item) => item.code === "source_rewrite_failed")).toBe(true);
    expect(statements.some((sql) => sql.startsWith("RENAME"))).toBe(false);
  });

  it.each([
    ["qualified calls", "CREATE OR REPLACE PROCEDURE P1 AS n NUMBER; BEGIN S2.Q(); SELECT COUNT(*) INTO n FROM OLD; END;", "CREATE OR REPLACE PROCEDURE P1 AS n NUMBER; BEGIN S1.Q(); SELECT COUNT(*) INTO n FROM OLD; END;"],
    ["no-argument calls", "CREATE OR REPLACE PROCEDURE P1 AS n NUMBER; BEGIN R; SELECT COUNT(*) INTO n FROM OLD; END;", "CREATE OR REPLACE PROCEDURE P1 AS n NUMBER; BEGIN Q; SELECT COUNT(*) INTO n FROM OLD; END;"],
    ["quoted built-in-looking calls", 'CREATE OR REPLACE PROCEDURE P1 AS n NUMBER; BEGIN "SUM"(); SELECT COUNT(*) INTO n FROM OLD; END;', "CREATE OR REPLACE PROCEDURE P1 AS n NUMBER; BEGIN COUNT(); SELECT COUNT(*) INTO n FROM OLD; END;"],
    ["quoted identifiers containing spaces", 'CREATE OR REPLACE PROCEDURE P1 AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM OLD; SELECT COUNT(*) INTO n FROM "A B"; END;', 'CREATE OR REPLACE PROCEDURE P1 AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM OLD; SELECT COUNT(*) INTO n FROM "AB"; END;'],
  ])("rejects changed %s identities", async (_label, draft, original) => {
    edges = [["OWNER", "P1", "PROCEDURE", null]];
    objects.delete(key("VIEW", "DEP"));
    objects.get(key("PROCEDURE", "P1"))!.source = original;
    const plan = await prepareOracleTableRename(target, { P1: draft });

    expect(plan.executable).toBe(false);
    expect(plan.issues.some((item) => item.code === "source_rewrite_failed")).toBe(true);
    expect(statements.some((sql) => sql.startsWith("RENAME"))).toBe(false);
  });

  it.each([
    ["a cross-owner root-name reference", "CREATE OR REPLACE PROCEDURE P1 AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM OLD; SELECT COUNT(*) INTO n FROM OTHER_OWNER.OLD; END;"],
    ["the second lowercase no-argument call", "CREATE OR REPLACE PROCEDURE P1 AS n NUMBER; BEGIN Q1; Q3; SELECT COUNT(*) INTO n FROM OLD; END;"],
  ])("rejects %s in a manual draft", async (_label, draft) => {
    edges = [["OWNER", "P1", "PROCEDURE", null]];
    objects.delete(key("VIEW", "DEP"));
    const original = _label === "the second lowercase no-argument call" ? "CREATE OR REPLACE PROCEDURE P1 AS n NUMBER; BEGIN Q1; Q2; SELECT COUNT(*) INTO n FROM OLD; END;" : "CREATE OR REPLACE PROCEDURE P1 AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM OLD; END;";
    objects.get(key("PROCEDURE", "P1"))!.source = original;
    const plan = await prepareOracleTableRename(target, { P1: draft });

    expect(plan.executable).toBe(false);
    expect(plan.issues.some((item) => item.code === "source_rewrite_failed")).toBe(true);
    expect(statements.some((sql) => sql.startsWith("RENAME"))).toBe(false);
  });

  it("stops after rename if the dependency graph drifts and never sends a rebuild", async () => {
    const plan = await prepareOracleTableRename(target);
    driftGraphAfterRename = true;
    await expect(executeOracleTableRename(plan)).rejects.toBeInstanceOf(OracleTableRenameFailure);
    expect(statements.filter((sql) => sql.startsWith("RENAME"))).toHaveLength(1);
    expect(statements.filter((sql) => sql.startsWith("CREATE"))).toHaveLength(0);
  });

  it("reconciles a lost rename reply by readback but sends no later DDL", async () => {
    const plan = await prepareOracleTableRename(target);
    loseRenameReply = true;
    await expect(executeOracleTableRename(plan)).rejects.toMatchObject({ reconciliation: "confirmed", completed: [], uncertain: "TABLE OLD" });
    expect(objects.has(key("TABLE", "NEW"))).toBe(true);
    expect(statements.filter((sql) => sql.startsWith("CREATE"))).toHaveLength(0);
  });

  it("reports unknown and sends no later DDL when rename readback fails", async () => {
    const isolatedTarget = { ...target, connectionId: "unknown-outcome-c" };
    const identity = captureSourceIdentity({ connectionId: isolatedTarget.connectionId, database: isolatedTarget.database, schema: isolatedTarget.schema, objectType: "TABLE", name: "OLD" });
    const plan = await prepareOracleTableRename(isolatedTarget);
    loseRenameReply = true;
    failRenameReadbackOnRename = true;
    await expect(executeOracleTableRename(plan)).rejects.toMatchObject({ reconciliation: "unknown", completed: [], uncertain: "TABLE OLD" });
    expect(statements.filter((sql) => sql.startsWith("CREATE"))).toHaveLength(0);
    expect(() => assertSourceIdentity(identity)).toThrow();
    expect(plan.dependents.every((dependent) => typeof dependent.draft === "string")).toBe(true);
  });

  it("stops after a dependent rebuild when the graph changes before the next step", async () => {
    const plan = await prepareOracleTableRename(target);
    driftGraphAfterFirstRebuild = true;
    await expect(executeOracleTableRename(plan)).rejects.toBeInstanceOf(OracleTableRenameFailure);
    expect(statements.filter((sql) => sql.startsWith("RENAME"))).toHaveLength(1);
    expect(statements.filter((sql) => sql.startsWith("CREATE"))).toHaveLength(1);
  });

  it("rechecks all rebuilt dependents together before reporting success", async () => {
    const plan = await prepareOracleTableRename(target);
    tamperCompletedViewAfterLaterRebuild = true;

    await expect(executeOracleTableRename(plan)).rejects.toBeInstanceOf(OracleTableRenameFailure);
    expect(objects.get(key("PROCEDURE", "P1"))?.source).toContain('FROM "OTHER"');
    expect(objects.has(key("TABLE", "NEW"))).toBe(true);
  });

  it("rechecks the root table indexes after all dependent rebuilds", async () => {
    tableIndexRows = [["IDX_OLD", "NORMAL", "UNIQUE", "VALID", null]];
    const plan = await prepareOracleTableRename(target);
    driftTableMetadataAfterRename = true;

    await expect(executeOracleTableRename(plan)).rejects.toBeInstanceOf(OracleTableRenameFailure);
    expect(objects.has(key("TABLE", "NEW"))).toBe(true);
  });

  it("stops before rebuilding dependents if another object reuses the old name", async () => {
    const plan = await prepareOracleTableRename(target);
    reuseOldNameAfterRename = true;
    await expect(executeOracleTableRename(plan)).rejects.toBeInstanceOf(OracleTableRenameFailure);
    expect(objects.get(key("TABLE", "NEW"))?.id).toBe("1");
    expect(objects.get(key("VIEW", "OLD"))?.id).toBe("88");
    expect(statements.filter((sql) => sql.startsWith("CREATE"))).toHaveLength(0);
  });

  it("allows a dependent view to receive a new identity after rebuild", async () => {
    edges = [["OWNER", "DEP", "VIEW", null]];
    objects.delete(key("PROCEDURE", "P1"));
    const plan = await prepareOracleTableRename(target);
    const priorId = plan.dependents[0].objectId;
    await expect(executeOracleTableRename(plan)).resolves.toBeUndefined();
    expect(plan.dependents[0].objectId).not.toBe(priorId);
    expect(objects.get(key("TABLE", "NEW"))?.id).toBe("1");
    expect(objects.has(key("TABLE", "OLD"))).toBe(false);
  });

  it("orders mixed view and routine dependents by graph edges rather than object type", async () => {
    edges = [
      ["OWNER", "P1", "PROCEDURE", null],
      ["OWNER", "DEP", "VIEW", null],
    ];
    referenceEdges.set(key("VIEW", "DEP"), [["OWNER", "P1", "PROCEDURE", null]]);
    const plan = await prepareOracleTableRename(target);
    expect(plan.executable).toBe(true);
    expect(plan.steps.map((step) => step.objectName)).toEqual(["OLD", "DEP", "P1"]);
  });

  it("rebuilds transitive views without requiring them to reference the renamed table directly", async () => {
    edges = [["OWNER", "DEP", "VIEW", null]];
    objects.delete(key("PROCEDURE", "P1"));
    objects.set(key("VIEW", "DEP2"), { type: "VIEW", id: "4", status: "VALID", source: "CREATE VIEW DEP2 AS SELECT ID FROM DEP", grant: "[]", error: "[]" });
    referenceEdges.set(key("VIEW", "DEP"), [["OWNER", "DEP2", "VIEW", null]]);
    const plan = await prepareOracleTableRename(target);

    expect(plan.executable).toBe(true);
    expect(plan.dependents.map(({ name, rewrittenSource }) => [name, rewrittenSource])).toEqual([
      ["DEP", 'CREATE VIEW DEP AS SELECT ID FROM "NEW"'],
      ["DEP2", "CREATE VIEW DEP2 AS SELECT ID FROM DEP"],
    ]);
    expect(plan.steps.at(-1)?.kind).toBe("compile");
    await expect(executeOracleTableRename(plan)).resolves.toBeUndefined();
  });

  it("rewrites only direct routine dependencies and compiles transitive callers", async () => {
    edges = [["OWNER", "P1", "PROCEDURE", null]];
    objects.delete(key("VIEW", "DEP"));
    objects.set(key("PROCEDURE", "P2"), { type: "PROCEDURE", id: "4", status: "VALID", source: "CREATE PROCEDURE P2 AS BEGIN P1; END;", grant: "[]", error: "[]" });
    referenceEdges.set(key("PROCEDURE", "P1"), [["OWNER", "P2", "PROCEDURE", null]]);
    const plan = await prepareOracleTableRename(target);

    expect(plan.executable).toBe(true);
    expect(plan.dependents.map(({ name, rewriteRequired }) => [name, rewriteRequired])).toEqual([
      ["P1", true],
      ["P2", false],
    ]);
    await expect(executeOracleTableRename(plan)).resolves.toBeUndefined();
    expect(objects.get(key("PROCEDURE", "P2"))?.source).toBe("CREATE PROCEDURE P2 AS BEGIN P1; END;");
    expect(statements).toContain('ALTER PROCEDURE "OWNER"."P2" COMPILE;');
  });

  it("preserves enabled and disabled trigger states through the confirmed rename steps", async () => {
    edges = [
      ["OWNER", "TR_ENABLED", "TRIGGER", null],
      ["OWNER", "TR_DISABLED", "TRIGGER", null],
    ];
    objects.delete(key("VIEW", "DEP"));
    objects.delete(key("PROCEDURE", "P1"));
    objects.set(key("TRIGGER", "TR_ENABLED"), {
      type: "TRIGGER",
      id: "4",
      status: "VALID",
      triggerStatus: "ENABLED",
      triggerTable: "OLD",
      source: "CREATE OR REPLACE TRIGGER TR_ENABLED BEFORE INSERT ON OLD FOR EACH ROW BEGIN NULL; END;\nALTER TRIGGER OWNER.TR_ENABLED ENABLE;",
      grant: "[]",
      error: "[]",
    });
    objects.set(key("TRIGGER", "TR_DISABLED"), {
      type: "TRIGGER",
      id: "5",
      status: "VALID",
      triggerStatus: "DISABLED",
      triggerTable: "OLD",
      source: "CREATE OR REPLACE TRIGGER TR_DISABLED BEFORE INSERT ON OLD FOR EACH ROW -- DISABLE\nDECLARE note VARCHAR2(10) := 'DISABLE'; BEGIN NULL; END;\nALTER TRIGGER OWNER.TR_DISABLED DISABLE;",
      grant: "[]",
      error: "[]",
    });

    const plan = await prepareOracleTableRename(target);
    expect(plan.executable).toBe(true);
    await expect(executeOracleTableRename(plan)).resolves.toBeUndefined();

    expect(objects.get(key("TRIGGER", "TR_ENABLED"))?.triggerStatus).toBe("ENABLED");
    expect(objects.get(key("TRIGGER", "TR_DISABLED"))?.triggerStatus).toBe("DISABLED");
    expect(objects.get(key("TRIGGER", "TR_ENABLED"))?.triggerTable).toBe("NEW");
    expect(objects.get(key("TRIGGER", "TR_DISABLED"))?.triggerTable).toBe("NEW");
    expect(objects.get(key("TRIGGER", "TR_DISABLED"))?.source).toContain("FOR EACH ROW DISABLE");
    expect(statements.filter((sql) => sql.startsWith("CREATE OR REPLACE TRIGGER"))).toHaveLength(2);
    expect(statements.filter((sql) => sql.startsWith("ALTER TRIGGER"))).toHaveLength(0);
  });

  it("inserts DISABLE after the trigger header even when a leading comment contains FOR EACH ROW", async () => {
    edges = [["OWNER", "TR_DISABLED", "TRIGGER", null]];
    objects.delete(key("VIEW", "DEP"));
    objects.delete(key("PROCEDURE", "P1"));
    objects.set(key("TRIGGER", "TR_DISABLED"), {
      type: "TRIGGER",
      id: "5",
      status: "VALID",
      triggerStatus: "DISABLED",
      triggerTable: "OLD",
      source: "-- FOR EACH ROW is mentioned here\nCREATE OR REPLACE TRIGGER TR_DISABLED BEFORE INSERT ON OLD FOR EACH ROW BEGIN NULL; END;\nALTER TRIGGER OWNER.TR_DISABLED DISABLE;",
      grant: "[]",
      error: "[]",
    });

    const plan = await prepareOracleTableRename(target);
    expect(plan.executable, JSON.stringify(plan.issues)).toBe(true);
    const triggerStep = plan.steps.find((step) => step.objectName === "TR_DISABLED")!;
    expect(triggerStep.sql).toContain('-- FOR EACH ROW is mentioned here\nCREATE OR REPLACE TRIGGER TR_DISABLED BEFORE INSERT ON "NEW" FOR EACH ROW DISABLE');
    await expect(executeOracleTableRename(plan)).resolves.toBeUndefined();
  });
});
