import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import {
  parseOracleForeignKeyDdl,
  readOracleForeignKeyDefinitions,
  readOracleForeignKeyConstraintNames,
  readOracleForeignKeySourceSnapshot,
  validateOracleForeignKeySourceChanges,
  readOracleForeignKeyReferenceSnapshot,
  validateOracleForeignKeyReference,
  compareOracleForeignKeyColumnTypes,
  checkOracleForeignKeyData,
  prepareOracleForeignKeyPlan,
  executeOracleForeignKeyPlan,
  prepareOracleForeignKeyCreatePlan,
  executeOracleForeignKeyCreatePlan,
  type OracleForeignKeyTarget,
  type OracleForeignKeySourceSnapshot,
} from "../oracleForeignKeys";

vi.mock("@/lib/backend/api", () => ({ executeQuery: vi.fn(), buildTableStructureChangeSql: vi.fn(), buildCreateTableSql: vi.fn() }));
const target: OracleForeignKeyTarget = { connectionId: "fixture", database: "APP", schema: "App Owner", tableName: "Child,Table", databaseType: "oracle" };
const state = { enabled: false, validated: false, deferrable: true, initiallyDeferred: true, rely: true };
const ddl = `ALTER TABLE "App Owner"."Child,Table" ADD CONSTRAINT "FK""name" FOREIGN KEY ("B", " A,quoted ") REFERENCES "Parent Owner"."Parent,Table" ("V", "ID""quoted") ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED RELY DISABLE NOVALIDATE;`;
const row = ['FK"name', "DISABLED", "NOT VALIDATED", "DEFERRABLE", "DEFERRED", "RELY", "Parent Owner", "PK_PARENT", "SET NULL"];
const result = (rows: unknown[][]) => ({ columns: [], rows, execution_time_ms: 0, rows_affected: 0 });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => result(sql.includes("SYS.ALL_TABLES") ? [[target.schema, target.tableName]] : sql.includes("SYS.ALL_CONSTRAINTS") ? [row] : [[ddl]]) as never);
});

describe("Oracle foreign key definition reads", () => {
  it.each([
    { user: "Other Owner", owner: "App Owner", view: "SYS.ALL_CONSTRAINTS" },
    { user: "app", owner: "APP", view: "SYS.ALL_CONSTRAINTS" },
    { user: "App Owner", owner: "App Owner", view: "SYS.USER_CONSTRAINTS" },
  ])("selects the name namespace from exact USER=$user, owner=$owner", async ({ user, owner, view }) => {
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => result(sql.includes("SELECT USER") ? [[user]] : [["FK_NAME", "SOURCE"]]) as never);
    await expect(readOracleForeignKeyConstraintNames({ ...target, schema: owner, databaseType: "oceanbase-oracle" })).resolves.toEqual([{ name: "FK_NAME", table: "SOURCE" }]);
    expect(vi.mocked(api.executeQuery).mock.calls[1]![2]).toContain(view);
    expect(vi.mocked(api.executeQuery).mock.calls.every((call) => !call[2].includes("CURRENT_SCHEMA"))).toBe(true);
  });

  it.each([{ users: [] }, { users: [[""]] }, { users: [[null]] }, { users: [["APP"], ["OTHER"]] }])("rejects invalid USER metadata without falling back ($users)", async ({ users }) => {
    vi.mocked(api.executeQuery).mockResolvedValue(result(users) as never);
    await expect(readOracleForeignKeyConstraintNames({ ...target, databaseType: "oceanbase-oracle" })).rejects.toThrow();
    expect(api.executeQuery).toHaveBeenCalledTimes(1);
  });
  it("reads an OB owner key hidden from ALL under column-level REFERENCES", async () => {
    const ownedTarget = { ...target, databaseType: "oceanbase-oracle" as const };
    const ownRow = [row[0], "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, ...row.slice(6)];
    const ownDdl = ddl.replace("DEFERRABLE INITIALLY DEFERRED RELY DISABLE NOVALIDATE;", "ENABLE;");
    vi.mocked(api.executeQuery).mockImplementation(
      async (_id, _db, sql) => result(sql.includes("SYS.ALL_TABLES") ? [[target.schema, target.tableName]] : sql.includes("SELECT USER") ? [[target.schema]] : sql.includes("SYS.USER_CONSTRAINTS") ? [ownRow] : sql.includes("SYS.ALL_CONSTRAINTS") ? [] : [[ownDdl]]) as never,
    );
    await expect(readOracleForeignKeyDefinitions(ownedTarget)).resolves.toHaveLength(1);
    expect(vi.mocked(api.executeQuery).mock.calls.some((call) => call[2].includes("SYS.USER_CONSTRAINTS"))).toBe(true);
  });
  it("preserves real reverse composite pairs, quoted identities and every state", async () => {
    const keys = await readOracleForeignKeyDefinitions(target);
    expect(keys).toEqual([{ name: 'FK"name', columns: ["B", " A,quoted "], refSchema: "Parent Owner", refTable: "Parent,Table", refColumns: ["V", 'ID"quoted'], onDelete: "SET NULL", state }]);
    expect(api.executeQuery).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.executeQuery).mock.calls.every((call) => call[2].startsWith("SELECT "))).toBe(true);
  });

  it("stops a segmented definition read when its generation changes after the first DDL fetch", async () => {
    let current = true;
    const secondRow = [...row];
    secondRow[0] = "FK_SECOND";
    const secondDdl = ddl.replace('"FK""name"', '"FK_SECOND"');
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => {
      if (sql.includes("SYS.ALL_TABLES")) return result([[target.schema, target.tableName]]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([row, secondRow]) as never;
      if (sql.includes("DBMS_METADATA.GET_DDL")) {
        current = false;
        return result([[sql.includes("FK_SECOND") ? secondDdl : ddl]]) as never;
      }
      return result([]) as never;
    });

    await expect(readOracleForeignKeyDefinitions(target, () => current)).rejects.toThrow();

    expect(api.executeQuery.mock.calls.filter((call) => String(call[2]).includes("DBMS_METADATA.GET_DDL"))).toHaveLength(1);
  });

  it.each([
    ddl + " DROP TABLE X",
    ddl.replace("DISABLE", "DISABLE ENABLE"),
    ddl.replace('"App Owner"', '"Other Owner"'),
    ddl.replace('"Parent Owner"', '"Other Parent"'),
    ddl.replace("SET NULL", "CASCADE"),
    ddl.replace("NOVALIDATE", "VALIDATE"),
    ddl.replace('"B", " A,quoted "', '"B", "B"'),
    ddl.replace('"V", "ID""quoted"', '"V"'),
    ddl.slice(0, 45),
  ])("rejects unsupported, incomplete or inconsistent DDL", (input) => {
    expect(() => parseOracleForeignKeyDdl(input, target, 'FK"name', "Parent Owner", "SET NULL", state)).toThrow();
  });

  it("does not guess unknown constraint status", async () => {
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => result(sql.includes("SYS.ALL_TABLES") ? [[target.schema, target.tableName]] : [[row[0], "UNKNOWN", ...row.slice(2)]]) as never);
    await expect(readOracleForeignKeyDefinitions(target)).rejects.toThrow();
    expect(api.executeQuery).toHaveBeenCalledTimes(2);
  });

  it("distinguishes visible empty table from missing metadata", async () => {
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => result(sql.includes("SYS.ALL_TABLES") ? [[target.schema, target.tableName]] : []) as never);
    await expect(readOracleForeignKeyDefinitions(target)).resolves.toEqual([]);
    vi.mocked(api.executeQuery).mockResolvedValue(result([]) as never);
    await expect(readOracleForeignKeyDefinitions(target)).rejects.toThrow();
  });

  it("never returns a partial set after a second definition read fails", async () => {
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => {
      if (sql.includes("SYS.ALL_TABLES")) return result([[target.schema, target.tableName]]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([row, ["FK_SECOND", ...row.slice(1)]]) as never;
      if (sql.includes("FK_SECOND")) throw new Error("Metadata access denied");
      return result([[ddl]]) as never;
    });
    await expect(readOracleForeignKeyDefinitions(target)).rejects.toThrow("Metadata access denied");
  });

  it("keeps every read bound to the captured target during a switch", async () => {
    let release!: (value: ReturnType<typeof result>) => void;
    vi.mocked(api.executeQuery).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve as typeof release;
        }) as never,
    );
    const mutableTarget = { ...target };
    const read = readOracleForeignKeyDefinitions(mutableTarget);
    mutableTarget.connectionId = "other-connection";
    mutableTarget.schema = "OTHER";
    mutableTarget.tableName = "OTHER_TABLE";
    release(result([[target.schema, target.tableName]]));
    await expect(read).resolves.toHaveLength(1);
    expect(vi.mocked(api.executeQuery).mock.calls.every((call) => call[0] === target.connectionId && call[3] === target.schema)).toBe(true);
  });
});

describe("Oracle foreign key source preflight", () => {
  function sourceFixture(objectId: unknown = 516042) {
    vi.mocked(api.executeQuery).mockImplementation(
      async (_id, _db, sql) =>
        result(
          sql.includes("SYS_CONTEXT")
            ? [["READER", target.schema]]
            : sql.includes("SYS.ALL_OBJECTS")
              ? [[target.schema, target.tableName, objectId]]
              : sql.includes("SYS.ALL_TAB_COLS")
                ? [
                    ["B", "NUMBER", 22, null, null, "Y"],
                    [" A,quoted ", "NUMBER", 22, 10, 0, "N"],
                  ]
                : sql.includes("SELECT CONSTRAINT_NAME, TABLE_NAME")
                  ? [
                      [row[0], target.tableName],
                      ["TAKEN", "OtherTable"],
                    ]
                  : sql.includes("SYS.ALL_TABLES")
                    ? [[target.schema, target.tableName]]
                    : sql.includes("SYS.ALL_CONSTRAINTS")
                      ? [row]
                      : [[ddl]],
        ) as never,
    );
  }

  it("captures physical object identity, column definitions and namespace without DDL", async () => {
    sourceFixture();
    const snapshot = await readOracleForeignKeySourceSnapshot(target);
    expect(snapshot.objectId).toBe("516042");
    expect(snapshot.user).toBe("READER");
    expect(snapshot.columns[1]).toMatchObject({ name: " A,quoted ", precision: "10", scale: "0", nullable: false });
    expect(snapshot.names).toContainEqual({ name: "TAKEN", table: "OtherTable" });
    expect(vi.mocked(api.executeQuery).mock.calls.every((call) => call[2].startsWith("SELECT "))).toBe(true);
    const original = snapshot.definitions[0]!;
    expect(() => validateOracleForeignKeySourceChanges(snapshot, target, [{ original, target: { ...original, name: "FK_NEW" } }])).not.toThrow();
  });

  it.each([null, 0, Number.MAX_SAFE_INTEGER + 1, "unknown"])("rejects unusable source object id %s", async (objectId) => {
    sourceFixture(objectId);
    await expect(readOracleForeignKeySourceSnapshot(target)).rejects.toThrow();
  });

  it("refuses stale originals, occupied names, absent columns and duplicate pairs before writes", async () => {
    sourceFixture();
    const snapshot = await readOracleForeignKeySourceSnapshot(target);
    const original = snapshot.definitions[0]!;
    for (const change of [
      { original: { ...original, onDelete: "CASCADE" as const }, target: original },
      { original, target: { ...original, name: "TAKEN" } },
      { original, target: { ...original, columns: ["MISSING", " A,quoted "] } },
      { original, target: { ...original, refColumns: ["V", "V"] } },
    ])
      expect(() => validateOracleForeignKeySourceChanges(snapshot, target, [change])).toThrow();
  });
});

describe("Oracle foreign key parent preflight", () => {
  const definition = parseOracleForeignKeyDdl(ddl, target, 'FK"name', "Parent Owner", "SET NULL", state);
  const source: OracleForeignKeySourceSnapshot = {
    user: "READER",
    currentSchema: target.schema,
    objectId: "1",
    columns: [
      { name: "B", dataType: "NUMBER", length: "22", precision: null, scale: null, nullable: true },
      { name: " A,quoted ", dataType: "NUMBER", length: "22", precision: null, scale: null, nullable: true },
    ],
    definitions: [definition],
    referenceKeys: [{ name: definition.name, owner: definition.refSchema, constraint: "PK_PARENT" }],
    names: [],
  };
  function parentFixture(columnOnly = false) {
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => {
      if (sql.includes("SESSION_PRIVS")) throw new Error("View unavailable");
      if (sql.includes("SYS.ALL_OBJECTS")) return result([[definition.refSchema, definition.refTable, 24]]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS"))
        return result([
          ["PK_PARENT", "P", "ENABLED", "VALIDATED", "NOT DEFERRABLE", 'ID"quoted', 1],
          ["PK_PARENT", "P", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "V", 2],
        ]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS"))
        return result([
          ['ID"quoted', "NUMBER"],
          ["V", "NUMBER"],
        ]) as never;
      if (sql.includes("SYS.ALL_TAB_PRIVS")) return result(columnOnly ? [] : [["REFERENCES"]]) as never;
      if (sql.includes("SYS.ALL_COL_PRIVS"))
        return result(
          columnOnly
            ? [
                ['ID"quoted', "REFERENCES"],
                ["V", "REFERENCES"],
              ]
            : [],
        ) as never;
      throw new Error("Unexpected query");
    });
  }

  it.each([false, true])("accepts table/column REFERENCES without demanding SELECT (columnOnly=%s)", async (columnOnly) => {
    parentFixture(columnOnly);
    const parent = await readOracleForeignKeyReferenceSnapshot(target, source.user, definition);
    expect(parent.references).toBe("present");
    expect(() => validateOracleForeignKeyReference(parent, source, definition, true)).not.toThrow();
    expect(parent.keys?.[0]?.columns).toEqual(['ID"quoted', "V"]);
    expect(definition.refColumns).toEqual(["V", 'ID"quoted']);
  });

  it("preserves unknown parent visibility for single ADD but blocks a destructive replacement", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(result([]) as never);
    const parent = await readOracleForeignKeyReferenceSnapshot(target, source.user, definition);
    expect(parent.objectId).toBeNull();
    expect(parent.keys).toBeNull();
    expect(() => validateOracleForeignKeyReference(parent, source, definition, false)).not.toThrow();
    expect(() => validateOracleForeignKeyReference(parent, source, definition, true)).toThrow();
  });

  it("rejects enabled child against a known disabled parent and certain type mismatch", async () => {
    parentFixture();
    const parent = await readOracleForeignKeyReferenceSnapshot(target, source.user, definition);
    const enabled = { ...definition, state: { ...state, enabled: true } };
    const disabledParent = { ...parent, keys: parent.keys!.map((key) => ({ ...key, enabled: false })) };
    expect(() => validateOracleForeignKeyReference(disabledParent, source, enabled, false)).toThrow();
    expect(() => validateOracleForeignKeyReference(parent, { ...source, columns: source.columns.map((column) => ({ ...column, dataType: "VARCHAR2" })) }, definition, true)).toThrow();
  });

  it("rejects DATE to NUMBER foreign key replacement and enforces type matrix", async () => {
    parentFixture();
    const parent = await readOracleForeignKeyReferenceSnapshot(target, source.user, definition);
    const dateSource: OracleForeignKeySourceSnapshot = {
      ...source,
      columns: source.columns.map((column) => ({ ...column, dataType: "DATE" })),
    };
    expect(() => validateOracleForeignKeyReference(parent, dateSource, definition, true)).toThrow();
  });

  it("evaluates canonical Oracle foreign key column type compatibility matrix", () => {
    // Compatible same-type / normalized parameters
    expect(compareOracleForeignKeyColumnTypes("NUMBER(10,2)", "NUMBER(5)")).toBe("compatible");
    expect(compareOracleForeignKeyColumnTypes("VARCHAR2(100 BYTE)", "VARCHAR2(200 CHAR)")).toBe("compatible");
    expect(compareOracleForeignKeyColumnTypes("TIMESTAMP(3)", "TIMESTAMP(6)")).toBe("compatible");
    expect(compareOracleForeignKeyColumnTypes("RAW(16)", "RAW(32)")).toBe("compatible");

    // Oracle NUMBER vs FLOAT and VARCHAR vs VARCHAR2
    expect(compareOracleForeignKeyColumnTypes("FLOAT(126)", "NUMBER(38)", "oracle")).toBe("compatible");
    expect(compareOracleForeignKeyColumnTypes("FLOAT(126)", "NUMBER(38)", "oceanbase-oracle")).toBe("incompatible");
    expect(compareOracleForeignKeyColumnTypes("VARCHAR(50)", "VARCHAR2(50)", "oracle")).toBe("compatible");
    expect(compareOracleForeignKeyColumnTypes("VARCHAR(50)", "VARCHAR2(50)", "oceanbase-oracle")).toBe("unknown");

    // Incompatible types
    expect(compareOracleForeignKeyColumnTypes("DATE", "NUMBER")).toBe("incompatible");
    expect(compareOracleForeignKeyColumnTypes("DATE", "TIMESTAMP")).toBe("incompatible");
    expect(compareOracleForeignKeyColumnTypes("CHAR", "NCHAR")).toBe("incompatible");
    expect(compareOracleForeignKeyColumnTypes("VARCHAR2", "NVARCHAR2")).toBe("incompatible");
    expect(compareOracleForeignKeyColumnTypes("BINARY_FLOAT", "BINARY_DOUBLE")).toBe("incompatible");
    expect(compareOracleForeignKeyColumnTypes("BINARY_FLOAT", "NUMBER")).toBe("incompatible");
    expect(compareOracleForeignKeyColumnTypes("TIMESTAMP", "TIMESTAMP WITH LOCAL TIME ZONE")).toBe("incompatible");

    // Unknown types
    expect(compareOracleForeignKeyColumnTypes("CUSTOM_TYPE", "NUMBER")).toBe("unknown");
    expect(compareOracleForeignKeyColumnTypes("NUMBER", "CLOB")).toBe("unknown");
    expect(compareOracleForeignKeyColumnTypes("VARCHAR2(100) INVALID_SUFFIX", "VARCHAR2(100)")).toBe("unknown");
  });
});

describe("Oracle foreign key data preflight", () => {
  const original = parseOracleForeignKeyDdl(ddl, target, 'FK"name', "Parent Owner", "SET NULL", state);
  const validated = { ...original, state: { ...state, validated: true, rely: false } };

  it("checks only fully nonnull composite rows and returns no business values", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(result([]) as never);
    await expect(checkOracleForeignKeyData(target, { original: null, target: validated }, false)).resolves.toEqual({ checked: true });
    const sql = vi.mocked(api.executeQuery).mock.calls[0]![2];
    expect(sql).toContain('SELECT 1 FROM "App Owner"."Child,Table"');
    expect(sql).toContain('fk_child."B" IS NOT NULL AND fk_child." A,quoted " IS NOT NULL');
    expect(sql).toContain('fk_parent."V" = fk_child."B" AND fk_parent."ID""quoted" = fk_child." A,quoted "');
    expect(sql).toContain("ROWNUM <= 1");
  });

  it("does not scan NOVALIDATE or pure rename", async () => {
    await expect(checkOracleForeignKeyData(target, { original: null, target: original }, false)).resolves.toEqual({ checked: false });
    await expect(checkOracleForeignKeyData(target, { original: validated, target: { ...validated, name: "FK_NEW" } }, false)).resolves.toEqual({ checked: false });
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("allows database validation of atomic ADD without SELECT but refuses deletion first", async () => {
    vi.mocked(api.executeQuery).mockRejectedValue(new Error("SELECT access denied"));
    await expect(checkOracleForeignKeyData(target, { original: null, target: validated }, false)).resolves.toEqual({ checked: false });
    await expect(checkOracleForeignKeyData(target, { original, target: validated }, true)).rejects.toMatchObject({ reason: "referenceDataUnreadable" });
  });

  it("rejects confirmed orphan data before any DDL", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(result([[1]]) as never);
    await expect(checkOracleForeignKeyData(target, { original: null, target: validated }, false)).rejects.toMatchObject({ reason: "referenceDataInvalid" });
    expect(vi.mocked(api.executeQuery).mock.calls.every((call) => call[2].startsWith("SELECT "))).toBe(true);
  });

  it("checks existing data when enabling a previously disabled validated key", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(result([[1]]) as never);
    await expect(checkOracleForeignKeyData(target, { original: validated, target: { ...validated, state: { ...validated.state, enabled: true } } }, false)).rejects.toMatchObject({ reason: "referenceDataInvalid" });
  });
});

describe("Oracle foreign key plan", () => {
  it("builds a complete static plan only after source, parent, permission and data checks", async () => {
    const created = { name: "FK_NEW", columns: ["B"], refSchema: "Parent Owner", refTable: "Parent,Table", refColumns: ['ID"quoted'], onDelete: "NO ACTION" as const, state: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false } };
    const change = { original: null, target: created };
    const statement = 'ALTER TABLE "App Owner"."Child,Table" ADD CONSTRAINT "FK_NEW" FOREIGN KEY ("B") REFERENCES "Parent Owner"."Parent,Table" ("ID""quoted") ENABLE VALIDATE;';
    const statements = [statement, 'ALTER TABLE "App Owner"."Child,Table" ADD CONSTRAINT "FK_SECOND" FOREIGN KEY ("B") REFERENCES "Parent Owner"."Parent,Table" ("ID""quoted") ENABLE VALIDATE;'];
    vi.mocked(api.buildTableStructureChangeSql).mockImplementation(async () => ({ statements, warnings: [] }) as never);
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => {
      if (sql.includes("SELECT USER,")) return result([["READER", target.schema]]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result(sql.includes("OWNER = 'App Owner'") ? [[target.schema, target.tableName, 516042]] : [["Parent Owner", "Parent,Table", 24]]) as never;
      if (sql.includes("SELECT CONSTRAINT_NAME, TABLE_NAME")) return result([]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([[target.schema, target.tableName]]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([["PK_PARENT", "P", "ENABLED", "VALIDATED", "NOT DEFERRABLE", 'ID"quoted', 1]]) as never;
      if (sql.includes("SESSION_PRIVS")) return result([]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS")) return result(sql.includes("OWNER = 'App Owner'") ? [["B", "NUMBER", 22, null, null, "Y"]] : [['ID"quoted', "NUMBER"]]) as never;
      if (sql.includes("SYS.ALL_TAB_PRIVS")) return result([["REFERENCES"]]) as never;
      if (sql.includes("SYS.ALL_COL_PRIVS")) return result([]) as never;
      if (sql.startsWith("SELECT 1 FROM")) return result([]) as never;
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const options = { databaseType: "oracle" as const, schema: target.schema, tableName: target.tableName, columns: [], indexes: [], foreignKeys: [] };
    const plan = await prepareOracleForeignKeyPlan(target, options, [change]);
    expect(plan.statements).toEqual(statements);
    expect(plan.groups).toEqual([{ change, statements, replacement: false }]);
    expect(plan.unverified).toEqual([]);
    expect(JSON.parse(plan.snapshot).source.objectId).toBe("516042");
    expect(vi.mocked(api.executeQuery).mock.calls.some((call) => !call[2].startsWith("SELECT "))).toBe(false);

    const readQuery = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation(async (...args) => {
      if (String(args[2]).startsWith("ALTER TABLE")) throw new Error("Response lost");
      return readQuery(...args) as never;
    });
    const execution = await executeOracleForeignKeyPlan(plan, 30, () => true);
    expect(execution?.steps.map((step) => step.state)).toEqual(["unknown", "notExecuted"]);
    expect(execution?.readbackError).toBeTruthy();
    expect(vi.mocked(api.executeQuery).mock.calls.filter((call) => String(call[2]).startsWith("ALTER TABLE"))).toHaveLength(1);
  });

  it("reports an in-flight DDL outcome as unknown after the generation changes", async () => {
    const created = { name: "FK_NEW", columns: ["B"], refSchema: "Parent Owner", refTable: "Parent,Table", refColumns: ['ID"quoted'], onDelete: "NO ACTION" as const, state: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false } };
    const change = { original: null, target: created };
    const statement = 'ALTER TABLE "App Owner"."Child,Table" ADD CONSTRAINT "FK_NEW" FOREIGN KEY ("B") REFERENCES "Parent Owner"."Parent,Table" ("ID""quoted") ENABLE VALIDATE;';
    vi.mocked(api.buildTableStructureChangeSql).mockResolvedValue({ statements: [statement], warnings: [] } as never);
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => {
      if (sql.includes("SELECT USER,")) return result([["READER", target.schema]]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result(sql.includes("OWNER = 'App Owner'") ? [[target.schema, target.tableName, 516042]] : [["Parent Owner", "Parent,Table", 24]]) as never;
      if (sql.includes("SELECT CONSTRAINT_NAME, TABLE_NAME")) return result([]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([[target.schema, target.tableName]]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([["PK_PARENT", "P", "ENABLED", "VALIDATED", "NOT DEFERRABLE", 'ID"quoted', 1]]) as never;
      if (sql.includes("SESSION_PRIVS")) return result([]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS")) return result(sql.includes("OWNER = 'App Owner'") ? [["B", "NUMBER", 22, null, null, "Y"]] : [['ID"quoted', "NUMBER"]]) as never;
      if (sql.includes("SYS.ALL_TAB_PRIVS")) return result([["REFERENCES"]]) as never;
      if (sql.includes("SYS.ALL_COL_PRIVS")) return result([]) as never;
      if (sql.startsWith("SELECT 1 FROM")) return result([]) as never;
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const options = { databaseType: "oracle" as const, schema: target.schema, tableName: target.tableName, columns: [], indexes: [], foreignKeys: [] };
    const plan = await prepareOracleForeignKeyPlan(target, options, [change]);
    const base = vi.mocked(api.executeQuery).getMockImplementation()!;
    let finish!: (value: ReturnType<typeof result>) => void;
    let current = true;
    vi.mocked(api.executeQuery).mockImplementation((...args) =>
      String(args[2]).startsWith("ALTER TABLE")
        ? (new Promise((resolve) => {
            finish = resolve as typeof finish;
          }) as never)
        : base(...args),
    );
    const pending = executeOracleForeignKeyPlan(plan, 30, () => current);
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 0));
    current = false;
    finish(result([]));

    const outcome = await pending;

    expect(outcome?.steps[0]?.state).toBe("unknown");
    expect(outcome?.readbackError).toContain("readback is unknown");
  });

  it("keeps a resolved DDL committed when only the UI target changes in flight", async () => {
    const created = { name: "FK_NEW", columns: ["B"], refSchema: "Parent Owner", refTable: "Parent,Table", refColumns: ['ID"quoted'], onDelete: "NO ACTION" as const, state: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false } };
    const statement = 'ALTER TABLE "App Owner"."Child,Table" ADD CONSTRAINT "FK_NEW" FOREIGN KEY ("B") REFERENCES "Parent Owner"."Parent,Table" ("ID""quoted") ENABLE VALIDATE;';
    vi.mocked(api.buildTableStructureChangeSql).mockResolvedValue({ statements: [statement], warnings: [] } as never);
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => {
      if (sql.includes("SELECT USER,")) return result([["READER", target.schema]]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result(sql.includes("OWNER = 'App Owner'") ? [[target.schema, target.tableName, 516042]] : [["Parent Owner", "Parent,Table", 24]]) as never;
      if (sql.includes("SELECT CONSTRAINT_NAME, TABLE_NAME")) return result([]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([[target.schema, target.tableName]]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([["PK_PARENT", "P", "ENABLED", "VALIDATED", "NOT DEFERRABLE", 'ID"quoted', 1]]) as never;
      if (sql.includes("SESSION_PRIVS")) return result([]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS")) return result(sql.includes("OWNER = 'App Owner'") ? [["B", "NUMBER", 22, null, null, "Y"]] : [['ID"quoted', "NUMBER"]]) as never;
      if (sql.includes("SYS.ALL_TAB_PRIVS")) return result([["REFERENCES"]]) as never;
      if (sql.includes("SYS.ALL_COL_PRIVS")) return result([]) as never;
      if (sql.startsWith("SELECT 1 FROM")) return result([]) as never;
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const options = { databaseType: "oracle" as const, schema: target.schema, tableName: target.tableName, columns: [], indexes: [], foreignKeys: [] };
    const plan = await prepareOracleForeignKeyPlan(target, options, [{ original: null, target: created }]);
    const base = vi.mocked(api.executeQuery).getMockImplementation()!;
    let finish!: (value: ReturnType<typeof result>) => void;
    let canStart = true;
    vi.mocked(api.executeQuery).mockImplementation((...args) =>
      String(args[2]).startsWith("ALTER TABLE")
        ? (new Promise((resolve) => {
            finish = resolve as typeof finish;
          }) as never)
        : base(...args),
    );
    const pending = executeOracleForeignKeyPlan(plan, 30, { canStart: () => canStart, connectionCurrent: () => true });
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 0));
    canStart = false;
    finish(result([]));

    const outcome = await pending;

    expect(outcome?.steps[0]?.state).toBe("committed");
    expect(outcome?.steps[0]?.error).toBeUndefined();
  });

  it("offers only an unoccupied original ADD after a confirmed replacement DROP and rejected ADD", async () => {
    const obTarget: OracleForeignKeyTarget = { ...target, databaseType: "oceanbase-oracle" };
    const original = { name: "FK_OLD", columns: ["B"], refSchema: "Parent Owner", refTable: "Parent,Table", refColumns: ["V"], onDelete: "NO ACTION" as const, state: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false } };
    const changed = { ...original, name: "FK_NEW" };
    const drop = 'ALTER TABLE "App Owner"."Child,Table" DROP CONSTRAINT "FK_OLD";';
    const add = 'ALTER TABLE "App Owner"."Child,Table" ADD CONSTRAINT "FK_NEW" FOREIGN KEY ("B") REFERENCES "Parent Owner"."Parent,Table" ("V") ENABLE VALIDATE;';
    const restore = 'ALTER TABLE "App Owner"."Child,Table" ADD CONSTRAINT "FK_OLD" FOREIGN KEY ("B") REFERENCES "Parent Owner"."Parent,Table" ("V") ENABLE VALIDATE;';
    const originalDdl = 'ALTER TABLE "App Owner"."Child,Table" ADD CONSTRAINT "FK_OLD" FOREIGN KEY ("B") REFERENCES "Parent Owner"."Parent,Table" ("V") ENABLE VALIDATE;';
    let exists = true;
    vi.mocked(api.buildTableStructureChangeSql).mockImplementation(async (options) => {
      const change = options.oracleForeignKeyChanges?.[0];
      return { statements: !change ? [drop, add] : change.original && change.target ? [drop, add] : [restore], warnings: [] } as never;
    });
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => {
      if (sql.startsWith("ALTER TABLE") && sql.includes("DROP CONSTRAINT")) {
        exists = false;
        return result([]) as never;
      }
      if (sql.startsWith("ALTER TABLE") && sql.includes('"FK_NEW"')) return { ...result([]), execution_error: true, error: { detail: "Unique key already exists" } } as never;
      if (sql === "SELECT USER FROM DUAL") return result([[obTarget.schema]]) as never;
      if (sql.includes("SELECT USER, SYS_CONTEXT")) return result([[obTarget.schema, obTarget.schema]]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([[obTarget.schema, obTarget.tableName]]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result(sql.includes("OWNER = 'App Owner'") ? (exists ? [[obTarget.schema, obTarget.tableName, 7]] : [[obTarget.schema, obTarget.tableName, 7]]) : [["Parent Owner", "Parent,Table", 24]]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS")) return result(sql.includes("OWNER = 'App Owner'") ? [["B", "NUMBER", 22, null, null, "Y"]] : [["V", "NUMBER"]]) as never;
      if (sql.includes("SELECT CONSTRAINT_NAME, TABLE_NAME")) return result(exists ? [["FK_OLD", obTarget.tableName]] : []) as never;
      if (sql.includes("JOIN SYS.ALL_CONS_COLUMNS")) return result([["PK_PARENT", "P", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "V", 1]]) as never;
      if (sql.includes("SYS.USER_CONSTRAINTS")) return result(exists ? [["FK_OLD", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, "Parent Owner", "PK_PARENT", "NO ACTION"]] : []) as never;
      if (sql.includes("DBMS_METADATA.GET_DDL")) return result([[originalDdl]]) as never;
      if (sql.includes("SYS.ALL_TAB_PRIVS")) return result([["REFERENCES"]]) as never;
      if (sql.includes("SYS.ALL_COL_PRIVS") || sql.includes("SESSION_PRIVS")) return result([]) as never;
      if (sql.startsWith("SELECT 1 FROM")) return result([]) as never;
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const options = { databaseType: "oceanbase-oracle" as const, schema: obTarget.schema, tableName: obTarget.tableName, columns: [], indexes: [], foreignKeys: [] };
    const plan = await prepareOracleForeignKeyPlan(obTarget, options, [{ original, target: changed }]);
    const execution = await executeOracleForeignKeyPlan(plan, 30, () => true);
    expect(execution?.steps.map((step) => step.state)).toEqual(["committed", "rejected"]);
    expect(execution?.recoverySql).toEqual([restore]);
  });

  it("generates manual recovery candidate after unconfirmed DROP when authoritative readback confirms missing", async () => {
    const obTarget: OracleForeignKeyTarget = { ...target, databaseType: "oceanbase-oracle" };
    const original = { name: "FK_OLD", columns: ["B"], refSchema: "Parent Owner", refTable: "Parent,Table", refColumns: ["V"], onDelete: "NO ACTION" as const, state: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false } };
    const changed = { ...original, name: "FK_NEW" };
    const drop = 'ALTER TABLE "App Owner"."Child,Table" DROP CONSTRAINT "FK_OLD";';
    const add = 'ALTER TABLE "App Owner"."Child,Table" ADD CONSTRAINT "FK_NEW" FOREIGN KEY ("B") REFERENCES "Parent Owner"."Parent,Table" ("V") ENABLE VALIDATE;';
    const restore = 'ALTER TABLE "App Owner"."Child,Table" ADD CONSTRAINT "FK_OLD" FOREIGN KEY ("B") REFERENCES "Parent Owner"."Parent,Table" ("V") ENABLE VALIDATE;';
    const originalDdl = 'ALTER TABLE "App Owner"."Child,Table" ADD CONSTRAINT "FK_OLD" FOREIGN KEY ("B") REFERENCES "Parent Owner"."Parent,Table" ("V") ENABLE VALIDATE;';
    let exists = true;
    vi.mocked(api.buildTableStructureChangeSql).mockImplementation(async (options) => {
      const change = options.oracleForeignKeyChanges?.[0];
      return { statements: !change ? [drop, add] : change.original && change.target ? [drop, add] : [restore], warnings: [] } as never;
    });
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => {
      if (sql.startsWith("ALTER TABLE") && sql.includes("DROP CONSTRAINT")) {
        exists = false;
        throw new Error("Connection reset by peer");
      }
      if (sql === "SELECT USER FROM DUAL") return result([[obTarget.schema]]) as never;
      if (sql.includes("SELECT USER, SYS_CONTEXT")) return result([[obTarget.schema, obTarget.schema]]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([[obTarget.schema, obTarget.tableName]]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result(sql.includes("OWNER = 'App Owner'") ? [[obTarget.schema, obTarget.tableName, 7]] : [["Parent Owner", "Parent,Table", 24]]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS")) return result(sql.includes("OWNER = 'App Owner'") ? [["B", "NUMBER", 22, null, null, "Y"]] : [["V", "NUMBER"]]) as never;
      if (sql.includes("SELECT CONSTRAINT_NAME, TABLE_NAME")) return result(exists ? [["FK_OLD", obTarget.tableName]] : []) as never;
      if (sql.includes("JOIN SYS.ALL_CONS_COLUMNS")) return result([["PK_PARENT", "P", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "V", 1]]) as never;
      if (sql.includes("SYS.USER_CONSTRAINTS")) return result(exists ? [["FK_OLD", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, "Parent Owner", "PK_PARENT", "NO ACTION"]] : []) as never;
      if (sql.includes("DBMS_METADATA.GET_DDL")) return result([[originalDdl]]) as never;
      if (sql.includes("SYS.ALL_TAB_PRIVS")) return result([["REFERENCES"]]) as never;
      if (sql.includes("SYS.ALL_COL_PRIVS") || sql.includes("SESSION_PRIVS")) return result([]) as never;
      if (sql.startsWith("SELECT 1 FROM")) return result([]) as never;
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const options = { databaseType: "oceanbase-oracle" as const, schema: obTarget.schema, tableName: obTarget.tableName, columns: [], indexes: [], foreignKeys: [] };
    const plan = await prepareOracleForeignKeyPlan(obTarget, options, [{ original, target: changed }]);
    const execution = await executeOracleForeignKeyPlan(plan, 30, () => true);
    expect(execution?.steps.map((step) => step.state)).toEqual(["unknown", "notExecuted"]);
    expect(execution?.recoverySql).toEqual([restore]);
  });

  it.each([
    ["original still exists", { exists: true, objectId: 7, nameOccupied: false, colType: "NUMBER", stillCurrent: true }],
    ["objectId changed", { exists: false, objectId: 999, nameOccupied: false, colType: "NUMBER", stillCurrent: true }],
    ["name occupied", { exists: false, objectId: 7, nameOccupied: true, colType: "NUMBER", stillCurrent: true }],
    ["column drifted", { exists: false, objectId: 7, nameOccupied: false, colType: "VARCHAR2", stillCurrent: true }],
    ["stillCurrent false", { exists: false, objectId: 7, nameOccupied: false, colType: "NUMBER", stillCurrent: false }],
  ])("withholds manual recovery when %s", async (_label, config) => {
    const obTarget: OracleForeignKeyTarget = { ...target, databaseType: "oceanbase-oracle" };
    const original = { name: "FK_OLD", columns: ["B"], refSchema: "Parent Owner", refTable: "Parent,Table", refColumns: ["V"], onDelete: "NO ACTION" as const, state: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false } };
    const changed = { ...original, name: "FK_NEW" };
    const drop = 'ALTER TABLE "App Owner"."Child,Table" DROP CONSTRAINT "FK_OLD";';
    const add = 'ALTER TABLE "App Owner"."Child,Table" ADD CONSTRAINT "FK_NEW" FOREIGN KEY ("B") REFERENCES "Parent Owner"."Parent,Table" ("V") ENABLE VALIDATE;';
    const restore = 'ALTER TABLE "App Owner"."Child,Table" ADD CONSTRAINT "FK_OLD" FOREIGN KEY ("B") REFERENCES "Parent Owner"."Parent,Table" ("V") ENABLE VALIDATE;';
    const originalDdl = 'ALTER TABLE "App Owner"."Child,Table" ADD CONSTRAINT "FK_OLD" FOREIGN KEY ("B") REFERENCES "Parent Owner"."Parent,Table" ("V") ENABLE VALIDATE;';
    let dropAttempted = false;
    vi.mocked(api.buildTableStructureChangeSql).mockImplementation(async (options) => {
      const change = options.oracleForeignKeyChanges?.[0];
      return { statements: !change ? [drop, add] : change.original && change.target ? [drop, add] : [restore], warnings: [] } as never;
    });
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => {
      if (sql.startsWith("ALTER TABLE") && sql.includes("DROP CONSTRAINT")) {
        dropAttempted = true;
        throw new Error("Connection reset by peer");
      }
      if (sql === "SELECT USER FROM DUAL") return result([[obTarget.schema]]) as never;
      if (sql.includes("SELECT USER, SYS_CONTEXT")) return result([[obTarget.schema, obTarget.schema]]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([[obTarget.schema, obTarget.tableName]]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result(sql.includes("OWNER = 'App Owner'") ? [[obTarget.schema, obTarget.tableName, dropAttempted ? config.objectId : 7]] : [["Parent Owner", "Parent,Table", 24]]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS")) return result(sql.includes("OWNER = 'App Owner'") ? [["B", dropAttempted ? config.colType : "NUMBER", 22, null, null, "Y"]] : [["V", "NUMBER"]]) as never;
      if (sql.includes("SELECT CONSTRAINT_NAME, TABLE_NAME")) {
        if (!dropAttempted) return result([["FK_OLD", obTarget.tableName]]) as never;
        if (config.nameOccupied) return result([["FK_OLD", obTarget.tableName]]) as never;
        return result(config.exists ? [["FK_OLD", obTarget.tableName]] : []) as never;
      }
      if (sql.includes("JOIN SYS.ALL_CONS_COLUMNS")) return result([["PK_PARENT", "P", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "V", 1]]) as never;
      if (sql.includes("SYS.USER_CONSTRAINTS")) return result(!dropAttempted || config.exists ? [["FK_OLD", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, "Parent Owner", "PK_PARENT", "NO ACTION"]] : []) as never;
      if (sql.includes("DBMS_METADATA.GET_DDL")) return result([[originalDdl]]) as never;
      if (sql.includes("SYS.ALL_TAB_PRIVS")) return result([["REFERENCES"]]) as never;
      if (sql.includes("SYS.ALL_COL_PRIVS") || sql.includes("SESSION_PRIVS")) return result([]) as never;
      if (sql.startsWith("SELECT 1 FROM")) return result([]) as never;
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const options = { databaseType: "oceanbase-oracle" as const, schema: obTarget.schema, tableName: obTarget.tableName, columns: [], indexes: [], foreignKeys: [] };
    const plan = await prepareOracleForeignKeyPlan(obTarget, options, [{ original, target: changed }]);
    let stale = false;
    const readQuery = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation((...args) => {
      if (config.stillCurrent === false && dropAttempted && String(args[2]).includes("SELECT CONSTRAINT_NAME, TABLE_NAME")) {
        stale = true;
        return Promise.resolve(result([])) as never;
      }
      return readQuery(...args);
    });
    const execution = await executeOracleForeignKeyPlan(plan, 30, () => !stale);
    expect(execution?.recoverySql).toBeUndefined();
  });
});

describe("Oracle foreign keys in new table plans", () => {
  it("rejects a self-reference to a non-key column before returning CREATE SQL", async () => {
    const createTarget = { ...target, schema: "APP", tableName: "NewTable" };
    const invalidDefinition = { name: "FK_BAD", columns: ["ID"], refSchema: "APP", refTable: "NewTable", refColumns: ["PARENT_ID"], onDelete: "NO ACTION" as const, state: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false } };
    vi.mocked(api.buildCreateTableSql).mockResolvedValue({ statements: ["CREATE TABLE APP.NEWTABLE (ID NUMBER)", "ALTER TABLE APP.NEWTABLE ADD CONSTRAINT FK_BAD FOREIGN KEY (ID) REFERENCES APP.NEWTABLE (PARENT_ID)"], warnings: [] } as never);
    vi.mocked(api.executeQuery).mockResolvedValue(result([["APP", "APP"]]) as never);
    await expect(
      prepareOracleForeignKeyCreatePlan(
        createTarget,
        {
          databaseType: "oracle",
          schema: "APP",
          tableName: "NewTable",
          columns: [
            { id: "id", name: "ID", dataType: "NUMBER", isNullable: false, isPrimaryKey: true },
            { id: "pid", name: "PARENT_ID", dataType: "NUMBER", isNullable: true, isPrimaryKey: false },
          ],
          indexes: [],
          foreignKeys: [],
        },
        [{ original: null, target: invalidDefinition }],
      ),
    ).rejects.toThrow();
    expect(vi.mocked(api.executeQuery).mock.calls.every((call) => String(call[2]).startsWith("SELECT "))).toBe(true);
  });

  it("preflights self-reference before CREATE and executes each statement once", async () => {
    const createTarget = { ...target, schema: "APP", tableName: "NewTable" };
    const definition = { name: "FK_NEW", columns: ["PARENT_ID"], refSchema: "APP", refTable: "NewTable", refColumns: ["ID"], onDelete: "NO ACTION" as const, state: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false } };
    const statements = ['CREATE TABLE "APP".NewTable (ID NUMBER NOT NULL, PARENT_ID NUMBER, CONSTRAINT PK_NEW PRIMARY KEY (ID));', 'ALTER TABLE "APP".NewTable ADD CONSTRAINT fk_new FOREIGN KEY (PARENT_ID) REFERENCES "APP".NewTable (ID) NORELY ENABLE VALIDATE;'];
    const ddl = 'ALTER TABLE "APP"."NEWTABLE" ADD CONSTRAINT "FK_NEW" FOREIGN KEY ("PARENT_ID") REFERENCES "APP"."NEWTABLE" ("ID") ENABLE VALIDATE;';
    vi.mocked(api.buildCreateTableSql).mockResolvedValue({ statements, warnings: [] } as never);
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => {
      if (sql.includes("SELECT USER, SYS_CONTEXT")) return result([["APP", "APP"]]) as never;
      if (sql.startsWith("CREATE TABLE") || sql.startsWith("ALTER TABLE")) return result([]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result([["APP", "NEWTABLE", 802]]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS"))
        return result([
          ["ID", "NUMBER", 22, null, null, "N"],
          ["PARENT_ID", "NUMBER", 22, null, null, "Y"],
        ]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([["APP", "NEWTABLE"]]) as never;
      if (sql.includes("SELECT CONSTRAINT_NAME, TABLE_NAME")) return result([["FK_NEW", "NEWTABLE"]]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([["FK_NEW", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, "APP", "PK_NEW", "NO ACTION"]]) as never;
      if (sql.includes("DBMS_METADATA.GET_DDL")) return result([[ddl]]) as never;
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const options = {
      databaseType: "oracle" as const,
      schema: createTarget.schema,
      tableName: createTarget.tableName,
      columns: [
        { id: "id", name: "ID", dataType: "NUMBER", isNullable: false, isPrimaryKey: true },
        { id: "pid", name: "PARENT_ID", dataType: "NUMBER", isNullable: true, isPrimaryKey: false },
      ],
      indexes: [],
      foreignKeys: [],
      primaryKeyName: "PK_NEW",
    };
    const changes = [{ original: null, target: definition }];
    const plan = await prepareOracleForeignKeyCreatePlan(createTarget, options, changes);
    expect(plan.statements).toEqual(statements);
    expect(vi.mocked(api.executeQuery).mock.calls.some((call) => String(call[2]).startsWith("CREATE TABLE"))).toBe(false);
    const execution = await executeOracleForeignKeyCreatePlan(plan, 30, () => true);
    expect(execution?.steps.map((step) => step.state)).toEqual(["committed", "committed"]);
    expect(execution?.readbackError).toBeUndefined();
    expect(vi.mocked(api.executeQuery).mock.calls.filter((call) => String(call[2]).startsWith("CREATE TABLE"))).toHaveLength(1);
    expect(vi.mocked(api.executeQuery).mock.calls.filter((call) => String(call[2]).startsWith("ALTER TABLE"))).toHaveLength(1);

    vi.mocked(api.executeQuery).mockClear();
    await expect(executeOracleForeignKeyCreatePlan(plan, 30, () => false)).resolves.toBeUndefined();
    expect(api.executeQuery).not.toHaveBeenCalled();
    vi.mocked(api.executeQuery).mockClear();
    const readQuery = vi.mocked(api.executeQuery).getMockImplementation()!;
    let current = true;
    let finish!: (value: ReturnType<typeof result>) => void;
    let readAfterStale = false;
    vi.mocked(api.executeQuery).mockImplementation((...args) => {
      const sql = String(args[2]);
      if (sql.startsWith("CREATE TABLE"))
        return new Promise((resolve) => {
          finish = resolve as typeof finish;
        }) as never;
      if (!current) readAfterStale = true;
      return readQuery(...args) as never;
    });
    const pendingLateCreate = executeOracleForeignKeyCreatePlan(plan, 30, () => current);
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 0));
    current = false;
    finish(result([]));
    const lateCreate = await pendingLateCreate;
    expect(lateCreate?.steps.map((step) => step.state)).toEqual(["unknown", "notExecuted"]);
    expect(lateCreate?.tableExists).toBeUndefined();
    expect(readAfterStale).toBe(false);
    expect(api.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("CREATE TABLE"))).toHaveLength(1);
  });

  it("matches Oracle self-reference readback after identifier folding", async () => {
    const createTarget = { ...target, schema: "APP", tableName: "child" };
    const definition = { name: "fk_self", columns: ["parent_id"], refSchema: "app", refTable: "CHILD", refColumns: ["id"], onDelete: "NO ACTION" as const, state: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false } };
    const statements = ['CREATE TABLE "APP".child (id NUMBER PRIMARY KEY, parent_id NUMBER)', 'ALTER TABLE "APP".child ADD CONSTRAINT fk_self FOREIGN KEY (parent_id) REFERENCES "app".CHILD (id)'];
    const ddl = 'ALTER TABLE "APP"."CHILD" ADD CONSTRAINT "FK_SELF" FOREIGN KEY ("PARENT_ID") REFERENCES "APP"."CHILD" ("ID") ENABLE VALIDATE;';
    vi.mocked(api.buildCreateTableSql).mockResolvedValue({ statements, warnings: [] } as never);
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => {
      if (sql.includes("SELECT USER, SYS_CONTEXT")) return result([["APP", "APP"]]) as never;
      if (sql.startsWith("CREATE TABLE") || sql.startsWith("ALTER TABLE")) return result([]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result([["APP", "CHILD", 802]]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS"))
        return result([
          ["ID", "NUMBER", 22, null, null, "N"],
          ["PARENT_ID", "NUMBER", 22, null, null, "Y"],
        ]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([["APP", "CHILD"]]) as never;
      if (sql.includes("SELECT CONSTRAINT_NAME, TABLE_NAME")) return result([["FK_SELF", "CHILD"]]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([["FK_SELF", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, "APP", "PK_NEW", "NO ACTION"]]) as never;
      if (sql.includes("DBMS_METADATA.GET_DDL")) return result([[ddl]]) as never;
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const options = {
      databaseType: "oracle" as const,
      schema: "APP",
      tableName: "child",
      columns: [
        { id: "id", name: "id", dataType: "NUMBER", isNullable: false, isPrimaryKey: true },
        { id: "pid", name: "parent_id", dataType: "NUMBER", isNullable: true, isPrimaryKey: false },
      ],
      indexes: [],
      foreignKeys: [],
      primaryKeyName: "PK_NEW",
    };
    const plan = await prepareOracleForeignKeyCreatePlan(createTarget, options, [{ original: null, target: definition }]);
    const executed = await executeOracleForeignKeyCreatePlan(plan, 30, () => true);
    expect(executed?.steps.map((step) => step.state)).toEqual(["committed", "committed"]);
    expect(executed?.readbackError).toBeUndefined();
  });

  it("accepts a reverse-ordered self reference to the new composite primary key", async () => {
    const createTarget = { ...target, schema: "APP", tableName: "NewTable" };
    const definition = { name: "FK_SELF", columns: ["X", "Y"], refSchema: "APP", refTable: "NewTable", refColumns: ["B", "A"], onDelete: "NO ACTION" as const, state: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false } };
    vi.mocked(api.buildCreateTableSql).mockResolvedValue({ statements: ['CREATE TABLE "APP".NewTable (A NUMBER, B NUMBER, X NUMBER, Y NUMBER, PRIMARY KEY (A, B))', 'ALTER TABLE "APP".NewTable ADD CONSTRAINT FK_SELF FOREIGN KEY (X, Y) REFERENCES "APP".NewTable (B, A)'], warnings: [] } as never);
    vi.mocked(api.executeQuery).mockResolvedValue(result([["APP", "APP"]]) as never);
    const options = {
      databaseType: "oracle" as const,
      schema: "APP",
      tableName: "NewTable",
      columns: [
        { id: "a", name: "A", dataType: "NUMBER", isNullable: false, isPrimaryKey: true },
        { id: "b", name: "B", dataType: "NUMBER", isNullable: false, isPrimaryKey: true },
        { id: "x", name: "X", dataType: "NUMBER", isNullable: true, isPrimaryKey: false },
        { id: "y", name: "Y", dataType: "NUMBER", isNullable: true, isPrimaryKey: false },
      ],
      indexes: [],
      foreignKeys: [],
      primaryKeyName: "PK_NEW",
    };
    await expect(prepareOracleForeignKeyCreatePlan(createTarget, options, [{ original: null, target: definition }])).resolves.toMatchObject({ references: [{ objectId: "new-table" }] });
  });

  it("does not fold a mixed-case external parent during new-table readback", async () => {
    const createTarget = { ...target, schema: "APP", tableName: "NewTable" };
    const external = { name: "FK_PARENT", columns: ["ID"], refSchema: "APP", refTable: "Parent", refColumns: ["ID"], onDelete: "NO ACTION" as const, state: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false } };
    const statements = ['CREATE TABLE "APP".NewTable (ID NUMBER PRIMARY KEY)', 'ALTER TABLE "APP".NewTable ADD CONSTRAINT FK_PARENT FOREIGN KEY (ID) REFERENCES "App"."Parent" ("id")'];
    const ddl = 'ALTER TABLE "APP"."NEWTABLE" ADD CONSTRAINT "FK_PARENT" FOREIGN KEY ("ID") REFERENCES "App"."PARENT" ("id") ENABLE VALIDATE;';
    vi.mocked(api.buildCreateTableSql).mockResolvedValue({ statements, warnings: [] } as never);
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => {
      if (sql.includes("SELECT USER, SYS_CONTEXT")) return result([["APP", "APP"]]) as never;
      if (sql.startsWith("CREATE TABLE") || sql.startsWith("ALTER TABLE")) return result([]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result(sql.includes("OBJECT_NAME = 'NEWTABLE'") ? [["APP", "NEWTABLE", 802]] : [["APP", "Parent", 903]]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS")) return result([["ID", "NUMBER", 22, null, null, "N"]]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([["APP", "NEWTABLE"]]) as never;
      if (sql.includes("SELECT CONSTRAINT_NAME, TABLE_NAME")) return result([["FK_PARENT", "NEWTABLE"]]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS") && sql.includes("CONSTRAINT_TYPE = 'R'")) return result([["FK_PARENT", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, "App", "PK_PARENT", "NO ACTION"]]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([["PK_PARENT", "P", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "ID", 1]]) as never;
      if (sql.includes("DBMS_METADATA.GET_DDL")) return result([[ddl]]) as never;
      if (sql.includes("SYS.ALL_TAB_PRIVS") || sql.includes("SYS.ALL_COL_PRIVS") || sql.includes("SESSION_PRIVS")) return result([["REFERENCES"]]) as never;
      if (sql.startsWith("SELECT 1 FROM")) return result([]) as never;
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const options = { databaseType: "oracle" as const, schema: "APP", tableName: "NewTable", columns: [{ id: "id", name: "ID", dataType: "NUMBER", isNullable: false, isPrimaryKey: true }], indexes: [], foreignKeys: [], primaryKeyName: "PK_NEW" };
    const plan = await prepareOracleForeignKeyCreatePlan(createTarget, options, [{ original: null, target: external }]);
    const executed = await executeOracleForeignKeyCreatePlan(plan, 30, () => true);
    expect(executed?.readbackError).toContain("differs from the submitted plan");
    expect(executed?.steps.map((step) => step.state)).toEqual(["committed", "committed"]);
  });

  it("reads back the target after an unknown CREATE response without retrying it", async () => {
    const createTarget = { ...target, schema: "APP", tableName: "NewTable" };
    const definition = { name: "FK_SELF", columns: ["ID"], refSchema: "APP", refTable: "NewTable", refColumns: ["ID"], onDelete: "NO ACTION" as const, state: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false } };
    const create = 'CREATE TABLE "APP".NewTable (ID NUMBER PRIMARY KEY)';
    vi.mocked(api.buildCreateTableSql).mockResolvedValue({ statements: [create, 'ALTER TABLE "APP".NewTable ADD CONSTRAINT FK_SELF FOREIGN KEY (ID) REFERENCES "APP".NewTable (ID)'], warnings: [] } as never);
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => {
      if (sql.includes("SELECT USER, SYS_CONTEXT")) return result([["APP", "APP"]]) as never;
      if (sql === create) throw new Error("Connection lost after request");
      if (sql.includes("SYS.ALL_TABLES")) return result([["APP", "NEWTABLE"]]) as never;
      if (sql.includes("SELECT CONSTRAINT_NAME, TABLE_NAME")) return result([]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([]) as never;
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const options = { databaseType: "oracle" as const, schema: "APP", tableName: "NewTable", columns: [{ id: "id", name: "ID", dataType: "NUMBER", isNullable: false, isPrimaryKey: true }], indexes: [], foreignKeys: [], primaryKeyName: "PK_NEW" };
    const plan = await prepareOracleForeignKeyCreatePlan(createTarget, options, [{ original: null, target: definition }]);
    const execution = await executeOracleForeignKeyCreatePlan(plan, 30, () => true);
    expect(execution?.steps.map((step) => step.state)).toEqual(["unknown", "notExecuted"]);
    expect(execution?.readbackError).toBeUndefined();
    expect(execution?.tableExists).toBe(true);
    expect(vi.mocked(api.executeQuery).mock.calls.filter((call) => String(call[2]).startsWith("CREATE TABLE"))).toHaveLength(1);
  });

  it("stops after a later FK fails and reports the committed partial create", async () => {
    const createTarget = { ...target, schema: "APP", tableName: "NewTable" };
    const state = { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false };
    const first = { name: "FK_FIRST", columns: ["PARENT_ID"], refSchema: "APP", refTable: "NewTable", refColumns: ["ID"], onDelete: "NO ACTION" as const, state };
    const second = { ...first, name: "FK_SECOND" };
    const create = 'CREATE TABLE "APP".NewTable (ID NUMBER NOT NULL, PARENT_ID NUMBER, CONSTRAINT PK_NEW PRIMARY KEY (ID));';
    const addFirst = 'ALTER TABLE "APP".NewTable ADD CONSTRAINT fk_first FOREIGN KEY (PARENT_ID) REFERENCES "APP".NewTable (ID) NORELY ENABLE VALIDATE;';
    const addSecond = 'ALTER TABLE "APP".NewTable ADD CONSTRAINT fk_second FOREIGN KEY (PARENT_ID) REFERENCES "APP".NewTable (ID) NORELY ENABLE VALIDATE;';
    const ddl = 'ALTER TABLE "APP"."NEWTABLE" ADD CONSTRAINT "FK_FIRST" FOREIGN KEY ("PARENT_ID") REFERENCES "APP"."NEWTABLE" ("ID") ENABLE VALIDATE;';
    vi.mocked(api.buildCreateTableSql).mockResolvedValue({ statements: [create, addFirst, addSecond], warnings: [] } as never);
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => {
      if (sql.includes("SELECT USER, SYS_CONTEXT")) return result([["APP", "APP"]]) as never;
      if (sql === addSecond.replace(/;$/, "")) return { ...result([]), execution_error: true, error: { detail: "Second foreign key rejected" } } as never;
      if (sql.startsWith("CREATE TABLE") || sql === addFirst.replace(/;$/, "")) return result([]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result([["APP", "NEWTABLE", 802]]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS"))
        return result([
          ["ID", "NUMBER", 22, null, null, "N"],
          ["PARENT_ID", "NUMBER", 22, null, null, "Y"],
        ]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([["APP", "NEWTABLE"]]) as never;
      if (sql.includes("SELECT CONSTRAINT_NAME, TABLE_NAME"))
        return result([
          ["FK_FIRST", "NEWTABLE"],
          ["FK_SECOND", "NEWTABLE"],
        ]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([["FK_FIRST", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, "APP", "PK_NEW", "NO ACTION"]]) as never;
      if (sql.includes("DBMS_METADATA.GET_DDL")) return result([[ddl]]) as never;
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const options = {
      databaseType: "oracle" as const,
      schema: createTarget.schema,
      tableName: createTarget.tableName,
      columns: [
        { id: "id", name: "ID", dataType: "NUMBER", isNullable: false, isPrimaryKey: true },
        { id: "pid", name: "PARENT_ID", dataType: "NUMBER", isNullable: true, isPrimaryKey: false },
      ],
      indexes: [],
      foreignKeys: [],
      primaryKeyName: "PK_NEW",
    };
    const changes = [
      { original: null, target: first },
      { original: null, target: second },
    ];
    const plan = await prepareOracleForeignKeyCreatePlan(createTarget, options, changes);
    const execution = await executeOracleForeignKeyCreatePlan(plan, 30, () => true);
    expect(execution?.steps.map((step) => step.state)).toEqual(["committed", "committed", "rejected"]);
    expect(execution?.readbackError).toBeUndefined();
    const writes = vi
      .mocked(api.executeQuery)
      .mock.calls.map((call) => String(call[2]))
      .filter((sql) => sql.startsWith("CREATE TABLE") || sql.startsWith("ALTER TABLE"));
    expect(writes).toEqual([create.replace(/;$/, ""), addFirst.replace(/;$/, ""), addSecond.replace(/;$/, "")]);
  });
});
