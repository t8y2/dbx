import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { executeOceanbasePrimaryKeyPlan, readOceanbasePrimaryKeySnapshot, prepareOraclePrimaryKeyChange } from "@/lib/database/oceanbasePrimaryKey";

vi.mock("@/lib/backend/api", () => ({ executeQuery: vi.fn(), getColumns: vi.fn(), listConstraints: vi.fn(), listIndexes: vi.fn() }));

const target = { connectionId: "ob", database: "APP", schema: "APP", tableName: "SOURCE" };
const change = { name: "PK_SOURCE", originalColumns: ["ID"], columns: ["V"] };
const rows = {
  key: [["PK_SOURCE", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", "APP", "PK_SOURCE"]],
  keyColumns: [["ID", 1]],
  table: [[null, "N"]],
  columns: [
    ["ID", "N", "NO"],
    ["V", "N", "NO"],
  ],
  references: [],
  index: [["APP", "PK_SOURCE", "NORMAL", "UNIQUE", "VALID", "VISIBLE", "NO"]],
  indexColumns: [["ID", 1, "ASC"]],
  indexUsers: [["APP", "SOURCE", "PK_SOURCE", "P"]],
  nulls: [[0]],
  duplicates: [[0]],
};
let fixture: Record<keyof typeof rows, unknown[][]>;
let truncated = false;
let capturedObjectId: unknown = 77;
let capturedIdentity: unknown[][] = [["APP", "APP", "ORCL"]];

beforeEach(() => {
  vi.resetAllMocks();
  truncated = false;
  capturedObjectId = 77;
  capturedIdentity = [["APP", "APP", "ORCL"]];
  fixture = structuredClone(rows);
  vi.mocked(api.getColumns).mockResolvedValue(["ID", "V"].map((name) => ({ name, data_type: "NUMBER", is_nullable: false, is_primary_key: name === "ID", column_default: null })));
  vi.mocked(api.listConstraints).mockResolvedValue([{ name: "PK_SOURCE", constraint_type: "PRIMARY KEY", columns: ["ID"], definition: "", ref_columns: [], enabled: true, valid: true, deferrable: false, initially_deferred: false }]);
  vi.mocked(api.listIndexes).mockResolvedValue([{ name: "PK_SOURCE", columns: ["ID"], is_unique: true, is_primary: true, index_type: "NORMAL" }]);
  vi.mocked(api.executeQuery).mockImplementation(async (_id, _database, sql) => {
    expect(sql).toMatch(/^SELECT /);
    if (sql.includes("SYS_CONTEXT")) return { columns: [], rows: capturedIdentity, affected_rows: 0, execution_time_ms: 0 };
    if (sql.includes("SYS.ALL_OBJECTS")) return { columns: [], rows: Array.isArray(capturedObjectId) ? capturedObjectId : [["APP", "SOURCE", capturedObjectId]], affected_rows: 0, execution_time_ms: 0 };
    if (sql.startsWith("SELECT RELY ")) return { columns: [], rows: [[null]], affected_rows: 0, execution_time_ms: 0 };
    if (sql.startsWith("SELECT INDEX_NAME FROM SYS.ALL_INDEXES")) {
      const name = /INDEX_NAME = '([^']+)'/.exec(sql)?.[1];
      return { columns: [], rows: name && fixture.index.some((row) => row[1] === name) ? [[name]] : [], affected_rows: 0, execution_time_ms: 0 };
    }
    if (sql.startsWith("SELECT CONSTRAINT_NAME FROM SYS.ALL_CONSTRAINTS")) {
      const name = /CONSTRAINT_NAME = '([^']+)'/.exec(sql)?.[1];
      return { columns: [], rows: name && fixture.key.some((row) => row[0] === name) ? [[name]] : [], affected_rows: 0, execution_time_ms: 0 };
    }
    if (sql.includes("SYS.ALL_EXTERNAL_TABLES")) return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 };
    const selected = sql.includes("R_CONSTRAINT_NAME")
      ? fixture.references
      : sql.includes("SYS.ALL_IND_COLUMNS")
        ? fixture.indexColumns
        : sql.includes("SYS.ALL_INDEXES")
          ? fixture.index
          : sql.includes("SYS.ALL_CONS_COLUMNS")
            ? fixture.keyColumns
            : sql.includes("SYS.ALL_TAB_COLS")
              ? fixture.columns
              : sql.includes("SYS.ALL_TABLES")
                ? fixture.table
                : sql.startsWith("SELECT OWNER, TABLE_NAME")
                  ? fixture.indexUsers
                  : sql.includes("SYS.ALL_CONSTRAINTS")
                    ? fixture.key
                    : sql.includes("GROUP BY")
                      ? fixture.duplicates
                      : sql.includes("IS NULL")
                        ? fixture.nulls
                        : undefined;
    if (!selected) throw new Error(`Unexpected query: ${sql}`);
    return { columns: [], rows: selected, affected_rows: 0, execution_time_ms: 0, truncated };
  });
});

describe("OceanBase existing primary key preflight", () => {
  it("reads the original key and supporting index, then checks target values without returning business values", async () => {
    const snapshot = await readOceanbasePrimaryKeySnapshot(target, change);
    expect(JSON.parse(snapshot).indexProperties).toEqual(fixture.index);
    expect(api.executeQuery).toHaveBeenCalledWith("ob", "APP", expect.stringContaining('GROUP BY "V"'), "APP", undefined, { maxRows: 10001, catalog: undefined });
    expect(api.executeQuery).toHaveBeenCalledWith("ob", "APP", expect.stringContaining("R_OWNER = 'APP'"), "APP", undefined, expect.anything());
  });

  it.each(["ENABLED", "DISABLED"])("rejects a cross-owner %s reference", async (state) => {
    fixture.references = [["CHILD_OWNER", "CHILD", "FK_PARENT", state]];
    await expect(readOceanbasePrimaryKeySnapshot(target, change)).rejects.toMatchObject({ key: "referenced", values: { names: "CHILD_OWNER.CHILD.FK_PARENT" } });
  });

  it.each([
    ["table", [["IOT", "N"]], "unsupportedTable"],
    ["key", [["PK_SOURCE", "DISABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", "APP", "PK_SOURCE"]], "unsupportedState"],
    ["keyColumns", [["V", 1]], "definitionChanged"],
    [
      "columns",
      [
        ["ID", "N", "NO"],
        ["V", "N", "YES"],
      ],
      "virtualColumn",
    ],
    ["columns", [["ID", "N", "NO"]], "incompleteMetadata"],
    ["index", [["APP", "PK_SOURCE", "NORMAL", "UNIQUE", "VALID", "INVISIBLE", "NO"]], "unsupportedIndex"],
    ["indexColumns", [["ID", 1, "DESC"]], "unsupportedIndex"],
    [
      "indexUsers",
      [
        ["APP", "SOURCE", "PK_SOURCE", "P"],
        ["APP", "SOURCE", "UQ_OTHER", "U"],
      ],
      "sharedIndex",
    ],
    ["nulls", [[1]], "nullValues"],
    ["duplicates", [[1]], "duplicateValues"],
    ["nulls", [], "incompleteMetadata"],
  ] as const)("rejects invalid %s metadata or data (%s)", async (key, value, expected) => {
    fixture[key] = value.map((row) => [...row]);
    await expect(readOceanbasePrimaryKeySnapshot(target, change)).rejects.toMatchObject({ key: expected });
  });

  it("rejects truncated query results", async () => {
    truncated = true;
    await expect(readOceanbasePrimaryKeySnapshot(target, change)).rejects.toMatchObject({ key: "incompleteMetadata" });
  });

  it("preserves metadata read failures", async () => {
    vi.mocked(api.listIndexes).mockRejectedValue(new Error("permission denied"));
    await expect(readOceanbasePrimaryKeySnapshot(target, change)).rejects.toThrow("permission denied");
  });

  it("checks all dependencies but skips new-key data checks for deletion", async () => {
    await readOceanbasePrimaryKeySnapshot(target, { ...change, columns: [] });
    expect(api.executeQuery.mock.calls.some((call) => call[2].includes("GROUP BY"))).toBe(false);
    expect(api.executeQuery.mock.calls.some((call) => call[2].includes("R_CONSTRAINT_NAME"))).toBe(true);
  });
});

describe("Native Oracle primary key index policy", () => {
  const oracleTarget = { ...target, databaseType: "oracle" as const };

  it("requires complete session and object identity and blocks session drift before DDL", async () => {
    const read = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation((...args) => (String(args[2]).includes("SYS_CONTEXT") ? (Promise.resolve({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 }) as never) : read(...args)));
    await expect(readOceanbasePrimaryKeySnapshot(oracleTarget, { ...change, columns: [] })).rejects.toMatchObject({ key: "incompleteMetadata" });
    expect(api.executeQuery.mock.calls.some((call) => String(call[2]).includes("SYS.ALL_OBJECTS") && String(call[2]).includes("OBJECT_NAME = 'SOURCE'"))).toBe(true);

    vi.mocked(api.executeQuery).mockImplementation(read);
    const deletion = { ...change, columns: [] };
    const prepared = await prepareOraclePrimaryKeyChange(oracleTarget, deletion);
    capturedIdentity = [["OTHER_USER", "APP", "ORCL"]];
    await expect(executeOceanbasePrimaryKeyPlan({ target: oracleTarget, ...prepared, statements: ['ALTER TABLE "APP"."SOURCE" DROP CONSTRAINT "PK_SOURCE" KEEP INDEX;'] }, 60, () => true)).rejects.toMatchObject({ key: "definitionChanged" });
    expect(api.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER TABLE"))).toBe(false);
  });

  it.each([
    ["missing session identity", "session", []],
    [
      "multiple session identities",
      "session",
      [
        ["APP", "APP", "ORCL"],
        ["APP", "APP", "ORCL"],
      ],
    ],
    ["missing object identity", "object", null],
    [
      "multiple object identities",
      "object",
      [
        ["APP", "SOURCE", 77],
        ["APP", "SOURCE", 78],
      ],
    ],
    ["invalid object identity", "object", "not-an-id"],
  ] as const)("rejects %s before returning a snapshot", async (_label, identityKind, value) => {
    if (identityKind === "session") capturedIdentity = value as unknown[][];
    else capturedObjectId = value;

    await expect(readOceanbasePrimaryKeySnapshot(oracleTarget, { ...change, columns: [] })).rejects.toMatchObject({ key: "incompleteMetadata" });
  });

  it("refuses execution when the captured table object is replaced with the same PK metadata", async () => {
    let objectId: number = 77;
    const read = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation((...args) => {
      if (String(args[2]).startsWith("ALTER TABLE")) return Promise.resolve({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 }) as never;
      if (String(args[2]).includes("SYS.ALL_OBJECTS")) return Promise.resolve({ columns: [], rows: [["APP", "SOURCE", objectId]], affected_rows: 0, execution_time_ms: 0 }) as never;
      return read(...args);
    });
    const deletion = { ...change, columns: [] };
    const prepared = await prepareOraclePrimaryKeyChange(oracleTarget, deletion);
    objectId = 78;

    await expect(executeOceanbasePrimaryKeyPlan({ target: oracleTarget, ...prepared, statements: ['ALTER TABLE "APP"."SOURCE" DROP CONSTRAINT "PK_SOURCE" KEEP INDEX;'] }, 60, () => true)).rejects.toMatchObject({ key: "definitionChanged" });

    expect(vi.mocked(api.executeQuery).mock.calls.some((args) => String(args[2]).startsWith("ALTER TABLE"))).toBe(false);
  });

  it("refuses OceanBase execution when the captured table object is replaced", async () => {
    let objectId = 77;
    const read = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation((...args) => (String(args[2]).includes("SYS.ALL_OBJECTS") ? (Promise.resolve({ columns: [], rows: [["APP", "SOURCE", objectId]], affected_rows: 0, execution_time_ms: 0 }) as never) : read(...args)));
    const deletion = { ...change, columns: [] };
    const snapshot = await readOceanbasePrimaryKeySnapshot(target, deletion);
    objectId = 78;

    await expect(executeOceanbasePrimaryKeyPlan({ target, change: deletion, snapshot, statements: ['ALTER TABLE "APP"."SOURCE" DROP CONSTRAINT "PK_SOURCE";'] }, 60, () => true)).rejects.toMatchObject({ key: "definitionChanged" });

    expect(vi.mocked(api.executeQuery).mock.calls.some((args) => String(args[2]).startsWith("ALTER TABLE"))).toBe(false);
  });

  it.each(["external", "unreadable"])("blocks %s table metadata before any DDL", async (mode) => {
    const originalQuery = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation((...args) => {
      if (args[2].includes("SYS.ALL_EXTERNAL_TABLES")) {
        if (mode === "unreadable") return Promise.reject(new Error("external metadata denied"));
        return Promise.resolve({ columns: [], rows: [["SOURCE"]], affected_rows: 0, execution_time_ms: 0 });
      }
      return originalQuery(...args);
    });
    await expect(executeOceanbasePrimaryKeyPlan({ target: oracleTarget, change: { ...change, columns: [] }, snapshot: "", statements: ['ALTER TABLE "APP"."SOURCE" DROP CONSTRAINT "PK_SOURCE";'] }, 60, () => true)).rejects.toThrow(
      mode === "external" ? "unsupportedTable" : "external metadata denied",
    );
    expect(api.executeQuery.mock.calls.every((call) => call[2].startsWith("SELECT "))).toBe(true);
  });

  it("ignores meaningless RELY changes on a validated key but invalidates a NOVALIDATE plan", async () => {
    let rely: unknown = null;
    const originalQuery = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation((...args) => (args[2].startsWith("SELECT RELY ") ? Promise.resolve({ columns: [], rows: [[rely]], affected_rows: 0, execution_time_ms: 0 }) : originalQuery(...args)));
    const deletion = { ...change, columns: [] };
    const validated = await prepareOraclePrimaryKeyChange(oracleTarget, deletion);
    rely = "RELY";
    await expect(readOceanbasePrimaryKeySnapshot(oracleTarget, validated.change)).resolves.toBe(validated.snapshot);
    fixture.key[0]![2] = "NOT VALIDATED";
    vi.mocked(api.listConstraints).mockResolvedValue([{ name: "PK_SOURCE", constraint_type: "PRIMARY KEY", columns: ["ID"], definition: "", ref_columns: [], enabled: true, valid: false, deferrable: false, initially_deferred: false }]);
    const unvalidated = await prepareOraclePrimaryKeyChange(oracleTarget, deletion);
    rely = null;
    await expect(executeOceanbasePrimaryKeyPlan({ target: oracleTarget, ...unvalidated, statements: ['ALTER TABLE "APP"."SOURCE" DROP CONSTRAINT "PK_SOURCE";'] }, 60, () => true)).rejects.toMatchObject({ key: "definitionChanged" });
    expect(api.executeQuery.mock.calls.every((call) => call[2].startsWith("SELECT "))).toBe(true);
  });

  it.each(["disabled-none", "disabled-keep", "deferred-keep"])("preserves %s state in deletion readback and manual recovery", async (mode) => {
    const enabled = mode === "deferred-keep";
    const indexed = mode !== "disabled-none";
    fixture.key = [["PK_SOURCE", enabled ? "ENABLED" : "DISABLED", "NOT VALIDATED", enabled ? "DEFERRABLE" : "NOT DEFERRABLE", enabled ? "DEFERRED" : "IMMEDIATE", indexed ? "APP" : null, indexed ? "PK_SOURCE" : null]];
    fixture.index[0]![3] = "NONUNIQUE";
    const constraint = { name: "PK_SOURCE", constraint_type: "PRIMARY KEY", columns: ["ID"], definition: "", ref_columns: [], enabled, valid: false, deferrable: enabled, initially_deferred: enabled };
    vi.mocked(api.listConstraints).mockResolvedValue([constraint]);
    // Same-named independent index must remain untouched for a key with no index association.
    vi.mocked(api.listIndexes).mockResolvedValue([{ name: "PK_SOURCE", columns: ["ID"], is_primary: indexed, is_unique: false, index_type: "NORMAL" }]);
    const originalQuery = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation((...args) => {
      const sql = args[2];
      const result = (rows: unknown[][] = []) => Promise.resolve({ columns: [], rows, affected_rows: 0, execution_time_ms: 0 });
      if (sql.startsWith("SELECT RELY ")) return result([["RELY"]]);
      if (sql.startsWith("ALTER ")) {
        vi.mocked(api.listConstraints).mockResolvedValue([]);
        return result();
      }
      if (sql.includes("PARTITIONED, TABLE_OWNER")) return result(fixture.index.map((row) => [...row, "APP", "SOURCE"]));
      return originalQuery(...args);
    });
    const prepared = await prepareOraclePrimaryKeyChange(oracleTarget, { ...change, columns: [] });
    const statements = [`ALTER TABLE "APP"."SOURCE" DROP CONSTRAINT "PK_SOURCE"${indexed ? " KEEP INDEX" : ""};`];
    const result = await executeOceanbasePrimaryKeyPlan({ target: oracleTarget, ...prepared, statements }, 60, () => true);
    expect(result?.readbackError).toBeUndefined();
    expect(result?.steps.map((step) => step.state)).toEqual(["committed"]);
    expect(result?.recoverySql).toBe(`ALTER TABLE "APP"."SOURCE" ADD CONSTRAINT "PK_SOURCE" PRIMARY KEY ("ID") ${enabled ? "DEFERRABLE INITIALLY DEFERRED" : "NOT DEFERRABLE INITIALLY IMMEDIATE"} RELY${enabled ? ' USING INDEX "APP"."PK_SOURCE"' : ""} ${enabled ? "ENABLE" : "DISABLE"} NOVALIDATE;`);
    expect(result?.indexStates).toEqual(indexed ? [{ name: "APP.PK_SOURCE", state: "indexPresent" }] : []);
    if (!indexed) expect(api.executeQuery.mock.calls.some((call) => call[2].includes("SYS.ALL_INDEXES") || call[2].includes("SYS.ALL_IND_COLUMNS"))).toBe(false);
  });

  it("captures a disabled unvalidated Oracle key without inventing a supporting index", async () => {
    fixture.key = [["PK_SOURCE", "DISABLED", "NOT VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, null]];
    fixture.index = [];
    fixture.indexColumns = [];
    fixture.indexUsers = [];
    vi.mocked(api.listIndexes).mockResolvedValue([]);
    vi.mocked(api.listConstraints).mockResolvedValue([{ name: "PK_SOURCE", constraint_type: "PRIMARY KEY", columns: ["ID"], definition: "", ref_columns: [], enabled: false, valid: false, deferrable: false, initially_deferred: false }]);
    const originalQuery = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation((...args) => (args[2].startsWith("SELECT RELY ") ? Promise.resolve({ columns: [], rows: [["RELY"]], affected_rows: 0, execution_time_ms: 0 }) : originalQuery(...args)));
    const prepared = await prepareOraclePrimaryKeyChange(oracleTarget, { ...change, columns: [] });
    expect(prepared.change).toMatchObject({ oracleState: { enabled: false, validated: false, deferrable: false, initiallyDeferred: false, rely: true }, oracleIndex: { policy: "none", owner: "APP", name: "" } });
    expect(api.executeQuery.mock.calls.some((call) => !call[2].startsWith("SELECT "))).toBe(false);
  });

  it("captures a deferred Oracle primary key backed by a nonunique index", async () => {
    fixture.key[0]![3] = "DEFERRABLE";
    fixture.key[0]![4] = "DEFERRED";
    fixture.index[0]![3] = "NONUNIQUE";
    vi.mocked(api.listIndexes).mockResolvedValue([{ name: "PK_SOURCE", columns: ["ID"], is_unique: false, is_primary: true, index_type: "NORMAL" }]);
    vi.mocked(api.listConstraints).mockResolvedValue([{ name: "PK_SOURCE", constraint_type: "PRIMARY KEY", columns: ["ID"], definition: "", ref_columns: [], enabled: true, valid: true, deferrable: true, initially_deferred: true }]);
    const originalQuery = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation((...args) => (args[2].startsWith("SELECT RELY ") ? Promise.resolve({ columns: [], rows: [[null]], affected_rows: 0, execution_time_ms: 0 }) : originalQuery(...args)));
    const prepared = await prepareOraclePrimaryKeyChange(oracleTarget, { ...change, columns: [] });
    expect(prepared.change).toMatchObject({ oracleState: { enabled: true, validated: true, deferrable: true, initiallyDeferred: true, rely: false }, oracleIndex: { policy: "keep", owner: "APP", name: "PK_SOURCE" } });
  });

  it("does not report success when replacement loses the captured validation state", async () => {
    fixture.key[0]![2] = "NOT VALIDATED";
    const sourceConstraint = { name: "PK_SOURCE", constraint_type: "PRIMARY KEY", columns: ["ID"], definition: "", ref_columns: [], enabled: true, valid: false, deferrable: false, initially_deferred: false };
    vi.mocked(api.listConstraints).mockResolvedValue([sourceConstraint]);
    let applied = false;
    let newIndex = "";
    const originalQuery = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation((...args) => {
      const sql = args[2];
      const result = (rows: unknown[][] = []) => Promise.resolve({ columns: [], rows, affected_rows: 0, execution_time_ms: 0 });
      if (sql.startsWith("SELECT INDEX_NAME FROM SYS.ALL_INDEXES")) return result();
      if (sql.includes(" DROP CONSTRAINT ")) {
        vi.mocked(api.listConstraints).mockResolvedValue([]);
        return result();
      }
      if (sql.includes(" ADD CONSTRAINT ")) {
        applied = true;
        vi.mocked(api.listConstraints).mockResolvedValue([{ ...sourceConstraint, columns: ["V"], valid: true }]);
        return result();
      }
      if (applied && sql.startsWith("SELECT CONSTRAINT_NAME, STATUS")) return result([["PK_SOURCE", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", "APP", newIndex]]);
      if (applied && sql.includes("PARTITIONED, TABLE_OWNER")) return result(sql.includes(`INDEX_NAME = '${newIndex}'`) ? [["APP", newIndex, "NORMAL", "NONUNIQUE", "VALID", "VISIBLE", "NO", "APP", "SOURCE"]] : fixture.index.map((row) => [...row, "APP", "SOURCE"]));
      if (applied && sql.includes("SYS.ALL_IND_COLUMNS") && sql.includes(`INDEX_NAME = '${newIndex}'`)) return result([["V", 1, "ASC"]]);
      return originalQuery(...args);
    });
    const prepared = await prepareOraclePrimaryKeyChange(oracleTarget, change);
    newIndex = prepared.change.oracleIndex!.newName!;
    const result = await executeOceanbasePrimaryKeyPlan(
      {
        target: oracleTarget,
        ...prepared,
        statements: ['ALTER TABLE "APP"."SOURCE" DROP CONSTRAINT "PK_SOURCE" KEEP INDEX;', `ALTER TABLE "APP"."SOURCE" ADD CONSTRAINT "PK_SOURCE" PRIMARY KEY ("V") NOT DEFERRABLE INITIALLY IMMEDIATE NORELY USING INDEX (CREATE INDEX "APP"."${newIndex}" ON "APP"."SOURCE" ("V")) ENABLE NOVALIDATE;`],
      },
      60,
      () => true,
    );
    expect(result?.steps.map((step) => step.state)).toEqual(["committed", "committed"]);
    expect(result?.indexStates?.map((index) => index.state)).toEqual(["indexPresent", "indexPresent"]);
    expect(result?.readbackError).toBe("definitionChanged");
  });

  it("rejects a new index name taken after preview before executing DDL", async () => {
    const read = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation(async (...args) => {
      if (args[2].startsWith("SELECT INDEX_NAME")) return { columns: [], rows: [["SOURCE_V_IDX"]], affected_rows: 0, execution_time_ms: 0 };
      return read(...args);
    });
    const verifiedChange = { ...change, oracleIndex: { policy: "keep" as const, owner: "APP", name: "PK_SOURCE", newName: "SOURCE_V_IDX" } };
    await expect(readOceanbasePrimaryKeySnapshot(oracleTarget, verifiedChange)).rejects.toMatchObject({ key: "definitionChanged" });
    expect(api.executeQuery.mock.calls.every((call) => call[2].startsWith("SELECT "))).toBe(true);
  });

  it("stops when the database rejects DROP for an invisible or concurrent reference", async () => {
    const deletion = { ...change, columns: [], oracleIndex: { policy: "keep" as const, owner: "APP", name: "PK_SOURCE" } };
    const snapshot = await readOceanbasePrimaryKeySnapshot(oracleTarget, deletion);
    const read = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation(async (...args) => {
      if (args[2].startsWith("ALTER ")) return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 0, execution_error: true, error: { detail: "ORA-02273: referenced by foreign keys" } };
      if (args[2].includes("PARTITIONED, TABLE_OWNER")) return { columns: [], rows: fixture.index.map((row) => [...row, "APP", "SOURCE"]), affected_rows: 0, execution_time_ms: 0 };
      return read(...args);
    });
    const result = await executeOceanbasePrimaryKeyPlan({ target: oracleTarget, change: deletion, snapshot, statements: ['ALTER TABLE "APP"."SOURCE" DROP CONSTRAINT "PK_SOURCE" KEEP INDEX;'] }, 30, () => true);
    expect(result?.steps[0]?.state).toBe("rejected");
    expect(result?.recoverySql).toBeUndefined();
    expect(result?.indexStates).toEqual([{ name: "APP.PK_SOURCE", state: "indexPresent" }]);
    expect(api.executeQuery.mock.calls.filter((call) => call[2].startsWith("ALTER "))).toHaveLength(1);
  });

  it("allocates the new index name in the owner's namespace without changing the draft", async () => {
    const read = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation(async (...args) => {
      if (args[2].startsWith("SELECT INDEX_NAME FROM SYS.ALL_INDEXES")) {
        const name = /INDEX_NAME = '([^']+)'/.exec(args[2])?.[1];
        return { columns: [], rows: name === "SOURCE_V_IDX" ? [[name]] : [], affected_rows: 0, execution_time_ms: 0 };
      }
      if (args[2].startsWith("SELECT CONSTRAINT_NAME FROM SYS.ALL_CONSTRAINTS")) return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 };
      return read(...args);
    });
    const prepared = await prepareOraclePrimaryKeyChange(oracleTarget, change);
    expect(prepared.change.oracleIndex).toEqual({ policy: "keep", owner: "APP", name: "PK_SOURCE", newName: "SOURCE_V_IDX_2" });
    expect(change).not.toHaveProperty("oracleIndex");
    expect(api.executeQuery.mock.calls.every((call) => call[2].startsWith("SELECT "))).toBe(true);
  });

  it("allows editing a reordered key backed by the original index order", async () => {
    fixture.keyColumns = [
      ["V", 1],
      ["ID", 2],
    ];
    fixture.indexColumns = [
      ["ID", 1, "ASC"],
      ["V", 2, "ASC"],
    ];
    vi.mocked(api.getColumns).mockResolvedValue(["ID", "V"].map((name) => ({ name, data_type: "NUMBER", is_nullable: false, is_primary_key: true })));
    vi.mocked(api.listConstraints).mockResolvedValue([{ name: "PK_SOURCE", constraint_type: "PRIMARY KEY", columns: ["V", "ID"], definition: "", ref_columns: [], enabled: true, valid: true, deferrable: false, initially_deferred: false }]);
    vi.mocked(api.listIndexes).mockResolvedValue([{ name: "PK_SOURCE", columns: ["ID", "V"], is_unique: true, is_primary: true, index_type: "NORMAL" }]);
    const draft = { name: "PK_SOURCE", originalColumns: ["V", "ID"], columns: ["ID", "V"] };
    const prepared = await prepareOraclePrimaryKeyChange(oracleTarget, draft);
    expect(prepared.change.oracleIndex).toEqual({ policy: "keep", owner: "APP", name: "PK_SOURCE" });
    await expect(readOceanbasePrimaryKeySnapshot(oracleTarget, { ...prepared.change, columns: [] })).resolves.toBe(prepared.snapshot);
    await expect(readOceanbasePrimaryKeySnapshot(target, draft)).rejects.toMatchObject({ key: "unsupportedIndex" });
  });

  it.each(["keep", "drop"] as const)("reads index state and supplies recovery after successful deletion with %s", async (policy) => {
    const deletion = { ...change, columns: [], oracleIndex: { policy, owner: "APP", name: "PK_SOURCE" } };
    const snapshot = await readOceanbasePrimaryKeySnapshot(oracleTarget, deletion);
    const read = vi.mocked(api.executeQuery).getMockImplementation()!;
    let dropped = false;
    vi.mocked(api.executeQuery).mockImplementation(async (...args) => {
      const sql = args[2];
      if (sql.startsWith("ALTER ")) {
        dropped = true;
        vi.mocked(api.listConstraints).mockResolvedValue([]);
        return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 };
      }
      if (dropped && sql.includes("SYS.ALL_INDEXES")) return { columns: [], rows: policy === "keep" ? fixture.index.map((row) => [...row, "APP", "SOURCE"]) : [], affected_rows: 0, execution_time_ms: 0 };
      if (dropped && sql.includes("SYS.ALL_IND_COLUMNS")) return { columns: [], rows: policy === "keep" ? fixture.indexColumns : [], affected_rows: 0, execution_time_ms: 0 };
      return read(...args);
    });
    const result = await executeOceanbasePrimaryKeyPlan({ target: oracleTarget, change: deletion, snapshot, statements: [`ALTER TABLE "APP"."SOURCE" DROP CONSTRAINT "PK_SOURCE" ${policy.toUpperCase()} INDEX;`] }, 30, () => true);
    expect(result?.steps[0]?.state).toBe("committed");
    expect(result?.readbackError).toBeUndefined();
    expect(result?.indexStates).toEqual([{ name: "APP.PK_SOURCE", state: policy === "keep" ? "indexPresent" : "indexAbsent" }]);
    expect(result?.recoverySql).toBe(`ALTER TABLE "APP"."SOURCE" ADD CONSTRAINT "PK_SOURCE" PRIMARY KEY ("ID")${policy === "keep" ? ' USING INDEX "APP"."PK_SOURCE"' : ""};`);
    expect(api.executeQuery.mock.calls.filter((call) => call[2].startsWith("ALTER "))).toHaveLength(1);
  });

  it("does not recommend reusing an index whose definition changed after DROP", async () => {
    const deletion = { ...change, columns: [], oracleIndex: { policy: "keep" as const, owner: "APP", name: "PK_SOURCE" } };
    const snapshot = await readOceanbasePrimaryKeySnapshot(oracleTarget, deletion);
    const read = vi.mocked(api.executeQuery).getMockImplementation()!;
    let dropped = false;
    vi.mocked(api.executeQuery).mockImplementation(async (...args) => {
      if (args[2].startsWith("ALTER ")) {
        dropped = true;
        vi.mocked(api.listConstraints).mockResolvedValue([]);
        return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 };
      }
      if (dropped && args[2].includes("SYS.ALL_INDEXES")) return { columns: [], rows: fixture.index.map((row) => [...row, "APP", "SOURCE"]), affected_rows: 0, execution_time_ms: 0 };
      if (dropped && args[2].includes("SYS.ALL_IND_COLUMNS")) return { columns: [], rows: [["V", 1, "ASC"]], affected_rows: 0, execution_time_ms: 0 };
      return read(...args);
    });
    const result = await executeOceanbasePrimaryKeyPlan({ target: oracleTarget, change: deletion, snapshot, statements: ['ALTER TABLE "APP"."SOURCE" DROP CONSTRAINT "PK_SOURCE" KEEP INDEX;'] }, 30, () => true);
    expect(result?.readbackError).toBe("definitionChanged");
    expect(result?.indexStates?.[0]?.state).toBe("indexChanged");
    expect(result?.recoverySql).not.toContain("USING INDEX");
    expect(result?.recoverySql?.split("\n").every((line) => line.startsWith("-- "))).toBe(true);
  });
});

describe("OceanBase primary key independent DDL execution", () => {
  const statements = ['ALTER TABLE "APP"."SOURCE" DROP CONSTRAINT "PK_SOURCE";', 'ALTER TABLE "APP"."SOURCE" ADD CONSTRAINT "PK_SOURCE" PRIMARY KEY ("V");'];

  it("provides manual recovery after a successful intentional key deletion without executing it", async () => {
    const deletion = { ...change, columns: [] };
    const snapshot = await readOceanbasePrimaryKeySnapshot(target, deletion);
    const read = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation(async (...args) => {
      if (args[2].includes(" DROP CONSTRAINT ")) {
        vi.mocked(api.listConstraints).mockResolvedValue([]);
        return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 };
      }
      return read(...args);
    });
    const result = await executeOceanbasePrimaryKeyPlan({ target, change: deletion, snapshot, statements: statements.slice(0, 1) }, 30, () => true);
    expect(result?.steps.map((step) => step.state)).toEqual(["committed"]);
    expect(result?.readbackError).toBeUndefined();
    expect(result?.recoverySql).toBe('ALTER TABLE "APP"."SOURCE" ADD CONSTRAINT "PK_SOURCE" PRIMARY KEY ("ID");');
    expect(vi.mocked(api.executeQuery).mock.calls.filter((call) => call[2].startsWith("ALTER "))).toHaveLength(1);
  });

  it.each(["rejected", "unknown"] as const)("keeps a committed DROP when ADD has a %s outcome", async (outcome) => {
    const snapshot = await readOceanbasePrimaryKeySnapshot(target, change);
    const read = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation(async (...args) => {
      if (args[2].includes(" DROP CONSTRAINT ")) {
        vi.mocked(api.listConstraints).mockResolvedValue([]);
        return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 };
      }
      if (args[2].includes(" ADD CONSTRAINT ")) {
        if (outcome === "unknown") throw new Error("connection lost");
        return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 0, execution_error: true, error: { detail: "duplicate key" } };
      }
      return read(...args);
    });
    const result = await executeOceanbasePrimaryKeyPlan({ target, change, snapshot, statements }, 30, () => true);
    expect(result?.steps.map((step) => step.state)).toEqual(["committed", outcome]);
    expect(result?.recoverySql).toContain('PRIMARY KEY ("ID")');
    expect(vi.mocked(api.executeQuery).mock.calls.filter((call) => call[2].startsWith("ALTER "))).toHaveLength(2);
  });

  it("does not execute ADD after DROP is rejected and does not suggest restoring an intact key", async () => {
    const snapshot = await readOceanbasePrimaryKeySnapshot(target, change);
    const read = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation(async (...args) => (args[2].startsWith("ALTER ") ? { columns: [], rows: [], affected_rows: 0, execution_time_ms: 0, execution_error: true, error: { detail: "ORA-02266" } } : read(...args)));
    const result = await executeOceanbasePrimaryKeyPlan({ target, change, snapshot, statements }, 30, () => true);
    expect(result?.steps.map((step) => step.state)).toEqual(["rejected", "notExecuted"]);
    expect(result?.recoverySql).toBeUndefined();
    expect(vi.mocked(api.executeQuery).mock.calls.filter((call) => call[2].startsWith("ALTER "))).toHaveLength(1);
  });

  it("preserves unknown execution when the original-target readback also fails", async () => {
    const snapshot = await readOceanbasePrimaryKeySnapshot(target, change);
    const read = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation(async (...args) => {
      if (args[2].startsWith("ALTER ")) {
        vi.mocked(api.listConstraints).mockRejectedValue(new Error("readback unavailable"));
        throw new Error("timeout");
      }
      return read(...args);
    });
    const result = await executeOceanbasePrimaryKeyPlan({ target, change, snapshot, statements }, 30, () => true);
    expect(result?.steps.map((step) => step.state)).toEqual(["unknown", "notExecuted"]);
    expect(result?.readbackError).toBe("readback unavailable");
    expect(result?.recoverySql).toBeUndefined();
  });

  it("rejects a reference added after preview before sending DDL", async () => {
    const snapshot = await readOceanbasePrimaryKeySnapshot(target, change);
    fixture.references = [["OTHER", "CHILD", "FK_NEW", "DISABLED"]];
    await expect(executeOceanbasePrimaryKeyPlan({ target, change, snapshot, statements }, 30, () => true)).rejects.toMatchObject({ key: "referenced" });
    expect(vi.mocked(api.executeQuery).mock.calls.some((call) => call[2].startsWith("ALTER "))).toBe(false);
  });

  it("rejects a column definition changed after preview before dropping the original key", async () => {
    const snapshot = await readOceanbasePrimaryKeySnapshot(target, change);
    vi.mocked(api.getColumns).mockResolvedValue(["ID", "V"].map((name) => ({ name, data_type: name === "V" ? "VARCHAR2(40)" : "NUMBER", is_nullable: false, is_primary_key: name === "ID", column_default: null })));
    await expect(executeOceanbasePrimaryKeyPlan({ target, change, snapshot, statements }, 30, () => true)).rejects.toMatchObject({ key: "definitionChanged" });
    expect(vi.mocked(api.executeQuery).mock.calls.some((call) => call[2].startsWith("ALTER "))).toBe(false);
  });

  it("cancels before DDL when the editor target or draft changed during revalidation", async () => {
    const snapshot = await readOceanbasePrimaryKeySnapshot(target, change);
    await expect(executeOceanbasePrimaryKeyPlan({ target, change, snapshot, statements }, 30, () => false)).resolves.toBeUndefined();
    expect(vi.mocked(api.executeQuery).mock.calls.some((call) => call[2].startsWith("ALTER "))).toBe(false);
  });
});
