import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { executeOracleIndexPlan, mergeOracleIndexDraftsAfterRefresh, oracleIndexSnapshotMatchesLoaded, oracleIndexSnapshotMatchesLoadedColumns, prepareOracleIndexPlan } from "../oracleIndexes";
import { createIndexDrafts } from "@/lib/table/tableStructureEditorState";
import { readOracleConstraintSnapshot, readOracleIndexSnapshot } from "../oracleConstraints";

vi.mock("@/lib/backend/api", () => ({ executeQuery: vi.fn(), listConstraints: vi.fn() }));

const target = { connectionId: "fixture", database: "APP", schema: "APP", tableName: "CONTACTS", databaseType: "oracle" as const };
const result = (rows: unknown[][], execution_error = false) => ({ execution_error, truncated: false, has_more: false, rows, error: execution_error ? { detail: "rejected" } : undefined });
const drafts = [
  {
    id: "old",
    name: "IX_OLD",
    columns: ["EMAIL"],
    isUnique: false,
    isPrimary: false,
    filter: "",
    indexType: "NORMAL",
    includedColumns: [],
    comment: "",
    original: { name: "IX_OLD", columns: ["EMAIL"], is_unique: false, is_primary: false, index_type: "NORMAL", key_metadata_complete: true, key_is_expression: [false], key_directions: ["ASC"], visibility: "VISIBLE", constraint_backed: false },
    markedForDrop: true,
  },
  { id: "new", name: "IX_NEW", columns: ["EMAIL"], isUnique: false, isPrimary: false, filter: "", indexType: "NORMAL", includedColumns: [], comment: "", markedForDrop: false },
];

describe("Oracle index plans", () => {
  let indexNames: string[];
  let supportedIndexes: Set<string>;
  let otherOwnerIndexNames: string[];
  let indexNamesReads: number;
  let ddl: string[];
  let rejectCreate: boolean;
  let indexColumns: unknown[][];
  let unrelatedOwnerIndexRows: unknown[][];
  let sharedIndexUsers: unknown[][];
  let functionIndexName: string | undefined;
  let failEnhancedColumns: boolean;
  let enhancedFailureRows: unknown[][] = [];
  let columnFlags = new Map<string, [string | null, string | null, string | null, string | null]>();

  beforeEach(() => {
    vi.resetAllMocks();
    indexNames = ["IX_OLD"];
    supportedIndexes = new Set();
    otherOwnerIndexNames = [];
    indexNamesReads = 0;
    ddl = [];
    rejectCreate = true;
    indexColumns = [["EMAIL", "VARCHAR2", 100, null, null, "Y"]];
    unrelatedOwnerIndexRows = [];
    sharedIndexUsers = [];
    functionIndexName = undefined;
    failEnhancedColumns = false;
    enhancedFailureRows = [];
    columnFlags = new Map();
    vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, sql) => {
      if (/^\s*(?:DROP|CREATE)\s+INDEX/i.test(sql)) {
        ddl.push(sql);
        if (/^\s*DROP/i.test(sql)) {
          const dropped = /DROP\s+INDEX\s+(?:"[^"]+"\.)?"?([^"\s;]+)"?/i.exec(sql)?.[1];
          indexNames = indexNames.filter((name) => name !== dropped);
          if (dropped === functionIndexName) {
            indexColumns = indexColumns.filter((row) => row[0] !== "SYS_NC00001$");
            functionIndexName = undefined;
          }
        }
        const rejected = /^\s*CREATE/i.test(sql) && rejectCreate;
        if (!rejected && /^\s*CREATE/i.test(sql)) {
          const name = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+"([^"]+)"/i.exec(sql)?.[1];
          if (name) indexNames.push(name);
          if (sql.includes("LOWER(EMAIL)")) {
            functionIndexName = name;
            indexColumns = [...indexColumns, ["SYS_NC00001$", "VARCHAR2", 100, null, null, "Y"]];
          }
        }
        return result([], rejected) as never;
      }
      if (sql.includes("SYS_CONTEXT")) return result([["APP", "APP", "ORCL"]]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result([["APP", "CONTACTS", 77]]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([[null, "N"]]) as never;
      if (sql.includes("SYS.ALL_EXTERNAL_TABLES")) return result([]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS")) {
        if (sql.includes("USER_GENERATED") && failEnhancedColumns) return result(enhancedFailureRows, true) as never;
        const rows = sql.includes("USER_GENERATED")
          ? indexColumns.map((row) => [...row, ...(columnFlags.get(String(row[0])) ?? ["B", ["VARCHAR2", "CHAR", "NVARCHAR2", "NCHAR"].includes(String(row[1])) ? String(row[2]) : null, row[0] === "SYS_NC00001$" ? "NO" : "YES", row[0] === "SYS_NC00001$" ? "YES" : "NO"])])
          : indexColumns;
        return result(rows) as never;
      }
      if (sql.includes("SELECT INDEX_NAME FROM SYS.ALL_INDEXES")) {
        indexNamesReads += 1;
        if (indexNamesReads === 5) supportedIndexes.add("IX_SECOND");
        const requested = [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
        const names = sql.includes("AND 1 = 0") ? [] : [...indexNames, ...otherOwnerIndexNames].filter((name) => requested.includes(name));
        return result(names.sort().map((name) => [name])) as never;
      }
      if (sql.includes("SYS.ALL_IND_COLUMNS"))
        return result([
          ...indexNames.map((name) => ["APP", name, "APP", "CONTACTS", name === functionIndexName ? "FUNCTION-BASED NORMAL" : "NORMAL", "NONUNIQUE", "VALID", "NO", "VISIBLE", "N", name === functionIndexName ? "SYS_NC00001$" : "EMAIL", "ASC", name === functionIndexName ? "LOWER(EMAIL)" : null]),
          ...unrelatedOwnerIndexRows.filter((row) => row[3] === "CONTACTS"),
        ]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([...supportedIndexes].map((name) => ["APP", name, "APP", "CONTACTS", `UQ_${name}`]).concat(sharedIndexUsers)) as never;
      throw new Error(`Unexpected SQL: ${sql}`);
    });
  });

  it("reads target indexes when unrelated indexes exceed the owner-wide row limit", async () => {
    unrelatedOwnerIndexRows = Array.from({ length: 10_000 }, (_, i) => ["APP", `IX_OTHER_${i}`, "APP", `TABLE_${i}`, "NORMAL", "NONUNIQUE", "VALID", "NO", "VISIBLE", "N", "EMAIL", "ASC", null]);

    const snapshot = await readOracleIndexSnapshot(target);

    expect(snapshot.indexes.map((index) => index.name)).toEqual(["IX_OLD"]);
  });

  it("does not accept a different dictionary owner as the same loaded index", async () => {
    const snapshot = await readOracleIndexSnapshot(target);
    const loaded = { ...drafts[0]!.original!, owner: "Other" };
    expect(oracleIndexSnapshotMatchesLoaded(snapshot, target, createIndexDrafts([loaded]))).toBe(false);
    expect(oracleIndexSnapshotMatchesLoaded(snapshot, target, createIndexDrafts([{ ...loaded, owner: "APP" }]))).toBe(true);
  });

  it("keeps draft IDs and refresh matching independent for equal index names under different owners", () => {
    const actual = ["APP", "Other"].map((owner) => ({ ...drafts[0]!.original!, owner }));
    const current = createIndexDrafts(actual);
    expect(new Set(current.map((draft) => draft.id)).size).toBe(2);
    const merged = mergeOracleIndexDraftsAfterRefresh(current, actual, []);
    expect(merged.map((draft) => draft.original?.owner)).toEqual(["APP", "Other"]);
    expect(merged.every((draft) => !draft.oracleOriginalMissing)).toBe(true);
    expect(createIndexDrafts([drafts[0]!.original!])[0]!.id).toBe("existing:IX_OLD");
  });

  it("refreshes an ownerless legacy draft from a unique dictionary row without changing its ID", () => {
    const [legacy] = createIndexDrafts([drafts[0]!.original!]);
    const actual = { ...drafts[0]!.original!, owner: "APP" };
    const merged = mergeOracleIndexDraftsAfterRefresh([legacy!], [actual], []);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "existing:IX_OLD", original: actual, oracleOriginalMissing: false });
  });

  it("does not resolve an ambiguous legacy owner after another draft consumes one same-name row", () => {
    const actual = ["APP", "Other"].map((owner) => ({ ...drafts[0]!.original!, owner }));
    const [known] = createIndexDrafts([actual[0]!]);
    const [legacy] = createIndexDrafts([drafts[0]!.original!]);
    const merged = mergeOracleIndexDraftsAfterRefresh([known!, { ...legacy!, markedForDrop: true }], actual, []);

    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ id: known!.id, original: { owner: "APP" }, oracleOriginalMissing: false });
    expect(merged[1]).toMatchObject({ id: legacy!.id, markedForDrop: true, oracleOriginalMissing: true });
    expect(merged[1]!.original!.owner).toBeUndefined();
    expect(merged[2]!.original!.owner).toBe("Other");
  });

  it("keeps a deletion draft unverifiable when dictionary identity is duplicated", () => {
    const actual = { ...drafts[0]!.original!, owner: "APP" };
    const [draft] = createIndexDrafts([actual]);
    const merged = mergeOracleIndexDraftsAfterRefresh([{ ...draft!, markedForDrop: true }], [actual, { ...actual }], []);

    expect(merged[0]).toMatchObject({ id: draft!.id, markedForDrop: true, oracleOriginalMissing: true });
  });

  it.each(["APP", "Other", undefined])("reconciles a completed CREATE only with its authoritative or uniquely ownerless readback (%s)", async (owner) => {
    const expected = (await readOracleIndexSnapshot(target)).indexes[0]!;
    const draft = { ...drafts[1]!, name: expected.name };
    const actual = { ...drafts[0]!.original!, owner };
    const merged = mergeOracleIndexDraftsAfterRefresh([draft], [actual], [expected]);

    expect(merged[0]!.id).toBe(draft.id);
    if (owner === "Other") {
      expect(merged).toHaveLength(2);
      expect(merged[0]!.original).toBeUndefined();
      expect(merged[1]!.original!.owner).toBe("Other");
    } else {
      expect(merged).toHaveLength(1);
      expect(merged[0]!.original!.owner).toBe(owner);
      expect(merged[0]!.oracleOriginalMissing).toBe(false);
    }
  });

  it("reads a target snapshot when unrelated owner index names exceed the row limit", async () => {
    otherOwnerIndexNames = Array.from({ length: 10_000 }, (_, i) => `IX_OTHER_${i}`);

    const snapshot = await readOracleIndexSnapshot(target);

    expect(snapshot.indexes.map((index) => index.name)).toEqual(["IX_OLD"]);
  });

  it("preserves same-named indexes from different owners and rejects ambiguous drafts", async () => {
    unrelatedOwnerIndexRows = [["OTHER", "IX_OLD", "APP", "CONTACTS", "NORMAL", "NONUNIQUE", "VALID", "NO", "VISIBLE", "N", "PHONE", "DESC", null]];
    sharedIndexUsers = [["OTHER", "IX_OLD", "OTHER", "OTHER_TABLE", "PK_OTHER"]];

    const fullSnapshot = await readOracleConstraintSnapshot(target, undefined, true);
    const indexSnapshot = await readOracleIndexSnapshot(target);
    await expect(prepareOracleIndexPlan(target, ['DROP INDEX "APP"."IX_OLD";', 'CREATE INDEX "IX_NEW" ON "APP"."CONTACTS" ("EMAIL");'], drafts as never)).rejects.toThrow("Index metadata changed");

    expect(fullSnapshot.indexes.map(({ owner, name, columns, directions, constraints }) => ({ owner, name, columns, directions, constraints }))).toEqual([
      { owner: "APP", name: "IX_OLD", columns: ["EMAIL"], directions: ["ASC"], constraints: [] },
      { owner: "OTHER", name: "IX_OLD", columns: ["PHONE"], directions: ["DESC"], constraints: [{ owner: "OTHER", tableName: "OTHER_TABLE", name: "PK_OTHER" }] },
    ]);
    expect(indexSnapshot.indexes.map(({ owner, name, columns, directions }) => ({ owner, name, columns, directions }))).toEqual([
      { owner: "APP", name: "IX_OLD", columns: ["EMAIL"], directions: ["ASC"] },
      { owner: "OTHER", name: "IX_OLD", columns: ["PHONE"], directions: ["DESC"] },
    ]);
    expect(ddl).toEqual([]);
  });

  it("does not invalidate a target plan when an unrelated owner index name changes", async () => {
    const plan = await prepareOracleIndexPlan(target, ['DROP INDEX "APP"."IX_OLD";', 'CREATE INDEX "IX_NEW" ON "APP"."CONTACTS" ("EMAIL");'], drafts as never);
    otherOwnerIndexNames = ["IX_OTHER_ADDED_AFTER_PREVIEW"];

    const outcome = await executeOracleIndexPlan(plan, 10, () => true);

    expect(outcome?.steps[0]?.state).toBe("committed");
  });

  it("stops after a rejected CREATE and reads back the completed DROP", async () => {
    const plan = await prepareOracleIndexPlan(target, ['DROP INDEX "APP"."IX_OLD";', 'CREATE INDEX "IX_NEW" ON "APP"."CONTACTS" ("EMAIL");'], drafts as never);

    const result = await executeOracleIndexPlan(plan, 10, () => true);

    expect(ddl).toHaveLength(2);
    expect(result?.steps.map((step) => step.state)).toEqual(["committed", "rejected"]);
    expect(result?.steps[1]?.error).toContain("Readback index names: none");
    expect(result?.steps[2]).toBeUndefined();
  });

  it("refuses stale index metadata before executing DDL", async () => {
    const plan = await prepareOracleIndexPlan(target, ['DROP INDEX "APP"."IX_OLD";', 'CREATE INDEX "IX_NEW" ON "APP"."CONTACTS" ("EMAIL");'], drafts as never);
    indexNames = ["IX_CHANGED"];

    await expect(executeOracleIndexPlan(plan, 10, () => true)).rejects.toThrow("Index metadata changed");

    expect(ddl).toHaveLength(0);
  });

  it("requires generated SQL identity to match the structured draft target", async () => {
    await expect(prepareOracleIndexPlan(target, ['DROP INDEX "APP"."IX_OTHER";'], drafts as never)).rejects.toThrow("Index metadata changed");

    expect(ddl).toHaveLength(0);
  });

  it("rejects a target index name already used by another table in the owner", async () => {
    otherOwnerIndexNames = ["IX_NEW"];

    await expect(prepareOracleIndexPlan(target, ['DROP INDEX "APP"."IX_OLD";', 'CREATE INDEX "IX_NEW" ON "APP"."CONTACTS" ("EMAIL");'], drafts as never)).rejects.toThrow("Index metadata changed");

    expect(ddl).toHaveLength(0);
  });

  it("preserves a shared index relation owned by a different table constraint", async () => {
    sharedIndexUsers = [["APP", "IX_OLD", "OTHER", "OTHER_TABLE", "UQ_SHARED"]];

    await expect(prepareOracleIndexPlan(target, ['DROP INDEX "APP"."IX_OLD";'], [drafts[0]!] as never)).rejects.toThrow("Index metadata changed");

    expect(api.executeQuery.mock.calls.some((call) => String(call[2]).includes("c.INDEX_OWNER, c.INDEX_NAME"))).toBe(true);
    expect(api.executeQuery.mock.calls.some((call) => String(call[2]).includes("ORDER BY c.INDEX_OWNER, c.INDEX_NAME, c.OWNER, c.TABLE_NAME, c.CONSTRAINT_NAME"))).toBe(true);
  });

  it("plans a CREATE when a missing index draft is restored to its original definition", async () => {
    indexNames = [];
    const recoverableDraft = { ...drafts[0]!, name: "IX_OLD", oracleOriginalMissing: true, markedForDrop: false };

    const plan = await prepareOracleIndexPlan(target, ['CREATE INDEX "IX_OLD" ON "APP"."CONTACTS" ("EMAIL");'], [recoverableDraft] as never);

    expect(plan.mutations).toHaveLength(1);
    expect(plan.mutations[0]?.operation).toBe("CREATE");
  });

  it("does not drop an index when its missing recovery draft is discarded", async () => {
    indexNames = [];
    const discardedDraft = { ...drafts[0]!, oracleOriginalMissing: true, markedForDrop: true };

    const plan = await prepareOracleIndexPlan(target, [], [discardedDraft] as never);

    expect(plan.statements).toEqual([]);
    expect(plan.mutations).toEqual([]);
  });

  it("keeps only incomplete renames as missing drafts after a partial refresh", () => {
    const originalA = { ...drafts[0]!.original, name: "IX_A", columns: ["EMAIL"] };
    const originalB = { ...drafts[0]!.original, name: "IX_B", columns: ["AGE"] };
    const draftA = { ...drafts[0]!, id: "a", name: "IX_A_NEW", original: originalA, markedForDrop: false };
    const draftB = { ...drafts[0]!, id: "b", name: "IX_B_NEW", original: originalB, columns: ["AGE"], markedForDrop: false };
    const actualA = { ...originalA, name: "IX_A_NEW", is_primary: false };
    const completedA = {
      owner: "APP",
      name: "IX_A_NEW",
      tableOwner: "APP",
      tableName: "CONTACTS",
      indexType: "NORMAL",
      uniqueness: "NONUNIQUE",
      status: "VALID",
      partitioned: false,
      visibility: "VISIBLE",
      secondary: null,
      columns: ["EMAIL"],
      directions: ["ASC"],
      keyIsExpression: [false],
      includedColumns: [],
      constraints: [],
    };

    const merged = mergeOracleIndexDraftsAfterRefresh([draftA, draftB] as never, [actualA] as never, [completedA]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ name: "IX_A_NEW", original: { name: "IX_A_NEW" }, indexType: "NORMAL" });
    expect(merged[0]?.oracleOriginalMissing).toBeUndefined();
    expect(merged[1]).toMatchObject({ name: "IX_B_NEW", original: { name: "IX_B" }, oracleOriginalMissing: true });
  });

  it("preserves a delete mark added after a completed rename before refresh", () => {
    const originalA = { ...drafts[0]!.original, name: "IX_A" };
    const originalB = { ...drafts[0]!.original, name: "IX_B", columns: ["AGE"] };
    const draftA = { ...drafts[0]!, id: "a", name: "IX_A_NEW", original: originalA, markedForDrop: true };
    const draftB = { ...drafts[0]!, id: "b", name: "IX_B_NEW", original: originalB, columns: ["AGE"], markedForDrop: false };
    const actualA = { ...originalA, name: "IX_A_NEW", is_primary: false };
    const completedA = {
      owner: "APP",
      name: "IX_A_NEW",
      tableOwner: "APP",
      tableName: "CONTACTS",
      indexType: "NORMAL",
      uniqueness: "NONUNIQUE",
      status: "VALID",
      partitioned: false,
      visibility: "VISIBLE",
      secondary: null,
      columns: ["EMAIL"],
      directions: ["ASC"],
      keyIsExpression: [false],
      includedColumns: [],
      constraints: [],
    };

    const merged = mergeOracleIndexDraftsAfterRefresh([draftA, draftB] as never, [actualA] as never, [completedA]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ name: "IX_A_NEW", original: { name: "IX_A_NEW" }, markedForDrop: true });
    expect(merged[1]).toMatchObject({ name: "IX_B_NEW", original: { name: "IX_B" }, oracleOriginalMissing: true });
  });

  it("preserves edits made after a completed rename before refresh", () => {
    const originalA = { ...drafts[0]!.original, name: "IX_A" };
    const originalB = { ...drafts[0]!.original, name: "IX_B", columns: ["AGE"] };
    const draftA = { ...drafts[0]!, id: "a", name: "IX_A_NEW", original: originalA, columns: ["AGE"], markedForDrop: false };
    const draftB = { ...drafts[0]!, id: "b", name: "IX_B_NEW", original: originalB, columns: ["AGE"], markedForDrop: false };
    const actualA = { ...originalA, name: "IX_A_NEW", columns: ["EMAIL"], is_primary: false };
    const completedA = {
      owner: "APP",
      name: "IX_A_NEW",
      tableOwner: "APP",
      tableName: "CONTACTS",
      indexType: "NORMAL",
      uniqueness: "NONUNIQUE",
      status: "VALID",
      partitioned: false,
      visibility: "VISIBLE",
      secondary: null,
      columns: ["EMAIL"],
      directions: ["ASC"],
      keyIsExpression: [false],
      includedColumns: [],
      constraints: [],
    };

    const merged = mergeOracleIndexDraftsAfterRefresh([draftA, draftB] as never, [actualA] as never, [completedA]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ name: "IX_A_NEW", columns: ["AGE"], original: { name: "IX_A_NEW", columns: ["EMAIL"] }, indexType: "NORMAL" });
    expect(merged[1]).toMatchObject({ name: "IX_B_NEW", original: { name: "IX_B" }, oracleOriginalMissing: true });
  });

  it("plans only the missing CREATE while retaining original function and visibility metadata", async () => {
    indexNames = [];
    const recoverableDraft = {
      ...drafts[0]!,
      name: "IX_NEW",
      columns: ["LOWER(EMAIL)"],
      indexType: "FUNCTION-BASED NORMAL",
      original: {
        ...drafts[0]!.original,
        columns: ["LOWER(EMAIL)"],
        key_is_expression: [true],
        key_directions: ["ASC"],
        index_type: "FUNCTION-BASED NORMAL",
        visibility: "INVISIBLE",
      },
      oracleOriginalMissing: true,
      markedForDrop: false,
    };

    const plan = await prepareOracleIndexPlan(target, ['CREATE INDEX "IX_NEW" ON "APP"."CONTACTS" (LOWER(EMAIL) ASC) INVISIBLE;'], [recoverableDraft] as never);

    expect(plan.mutations).toHaveLength(1);
    expect(plan.mutations[0]?.operation).toBe("CREATE");
    expect(plan.mutations[0]?.expectedAfter[0]).toMatchObject({ keyIsExpression: [true], directions: ["ASC"], visibility: "INVISIBLE" });
  });

  it("reads through the confirmed internal column created by a function index", async () => {
    indexNames = [];
    rejectCreate = false;
    const recoverableDraft = {
      ...drafts[0]!,
      name: "IX_NEW",
      columns: ["LOWER(EMAIL)"],
      indexType: "FUNCTION-BASED NORMAL",
      original: {
        ...drafts[0]!.original,
        columns: ["LOWER(EMAIL)"],
        key_is_expression: [true],
        key_directions: ["ASC"],
        index_type: "FUNCTION-BASED NORMAL",
      },
      oracleOriginalMissing: true,
      markedForDrop: false,
    };
    const plan = await prepareOracleIndexPlan(target, ['CREATE INDEX "IX_NEW" ON "APP"."CONTACTS" (LOWER(EMAIL) ASC);'], [recoverableDraft] as never);

    const execution = await executeOracleIndexPlan(plan, 10, () => true);

    expect(ddl).toHaveLength(1);
    expect(execution?.steps.map((step) => step.state)).toEqual(["committed"]);
    expect(execution?.readbackError).toBeUndefined();
  });

  it("checks internal-column projection after a function-index DROP and CREATE chain", async () => {
    indexNames = ["IX_OLD"];
    functionIndexName = "IX_OLD";
    indexColumns = [
      ["EMAIL", "VARCHAR2", 100, null, null, "Y"],
      ["SYS_NC00001$", "VARCHAR2", 100, null, null, "Y"],
    ];
    rejectCreate = false;
    const functionDraft = {
      id: "rename-function",
      name: "IX_NEW",
      columns: ["LOWER(EMAIL)"],
      isUnique: false,
      isPrimary: false,
      filter: "",
      indexType: "FUNCTION-BASED NORMAL",
      includedColumns: [],
      comment: "",
      markedForDrop: false,
      original: { name: "IX_OLD", columns: ["LOWER(EMAIL)"], is_unique: false, is_primary: false, index_type: "FUNCTION-BASED NORMAL", key_metadata_complete: true, key_is_expression: [true], key_directions: ["ASC"], visibility: "VISIBLE", constraint_backed: false },
    };
    const plan = await prepareOracleIndexPlan(target, ['DROP INDEX "APP"."IX_OLD";', 'CREATE INDEX "IX_NEW" ON "APP"."CONTACTS" (LOWER(EMAIL) ASC);'], [functionDraft] as never);

    const execution = await executeOracleIndexPlan(plan, 10, () => true);

    expect(ddl).toHaveLength(2);
    expect(execution?.steps.map((step) => step.state)).toEqual(["committed", "committed"]);
    expect(execution?.readbackError).toBeUndefined();
  });

  it("executes later CREATE steps for multiple changed indexes", async () => {
    rejectCreate = false;
    const extraDraft = { ...drafts[1]!, id: "extra", name: "IX_EXTRA" };
    const plan = await prepareOracleIndexPlan(target, ['DROP INDEX "APP"."IX_OLD";', 'CREATE INDEX "IX_NEW" ON "APP"."CONTACTS" ("EMAIL");', 'CREATE INDEX "IX_EXTRA" ON "APP"."CONTACTS" ("EMAIL");'], [drafts[0]!, drafts[1]!, extraDraft] as never);

    const execution = await executeOracleIndexPlan(plan, 10, () => true);

    expect(ddl).toHaveLength(3);
    expect(indexNames).toEqual(["IX_NEW", "IX_EXTRA"]);
    expect(
      execution?.steps.map((step) => step.state),
      JSON.stringify(execution),
    ).toEqual(["committed", "committed", "committed"]);
    expect(execution?.readbackError).toBeUndefined();
  });

  it("keeps internal-column projection conservative for unknown flags and NO+NO", async () => {
    indexColumns = [
      ["EMAIL", "VARCHAR2", 100, null, null, "Y"],
      ["SYS_NC00001$", "VARCHAR2", 100, null, null, "Y"],
      ["SYS_NC00002$", "VARCHAR2", 100, null, null, "Y"],
    ];
    columnFlags.set("SYS_NC00001$", ["B", "100", "NO", "YES"]);
    columnFlags.set("SYS_NC00002$", ["B", "100", "NO", "NO"]);

    const snapshot = await readOracleIndexSnapshot(target);

    expect(snapshot.columns.map((column) => column.name)).toEqual(["EMAIL", "SYS_NC00001$", "SYS_NC00002$"]);
    expect(snapshot.userColumns.map((column) => column.name)).toEqual(["EMAIL", "SYS_NC00002$"]);
    columnFlags.set("SYS_NC00002$", ["unknown", "100", "NO", null]);
    const unknown = await readOracleIndexSnapshot(target);
    expect(unknown.userColumns.map((column) => column.name)).toContain("SYS_NC00002$");
  });

  it("retains YES+YES hidden columns and user-named SYS_NC columns", async () => {
    indexColumns = [
      ["EMAIL", "VARCHAR2", 100, null, null, "Y"],
      ["SYS_NC_USER", "VARCHAR2", 100, null, null, "Y"],
      ["SYS_NC00003$", "VARCHAR2", 100, null, null, "Y"],
    ];
    columnFlags.set("SYS_NC_USER", ["B", "100", "YES", "YES"]);
    columnFlags.set("SYS_NC00003$", ["B", "100", "YES", "YES"]);

    const snapshot = await readOracleIndexSnapshot(target);

    expect(snapshot.userColumns.map((column) => column.name)).toEqual(["EMAIL", "SYS_NC_USER", "SYS_NC00003$"]);
  });

  it("falls back to a complete strict-base read without claiming charset detection", async () => {
    failEnhancedColumns = true;
    enhancedFailureRows = [["EMAIL", "WRONG_TYPE", 999, 1, 2, "N", "C", 999, "NO", "YES"]];

    const snapshot = await readOracleIndexSnapshot(target);

    expect(snapshot.columnReadMode).toBe("strict-base");
    expect(snapshot.columns).toEqual([{ name: "EMAIL", dataType: "VARCHAR2", length: "100", precision: null, scale: null, nullable: true }]);
    expect(snapshot.userColumns).toEqual(snapshot.columns);
  });

  it("refuses an enhanced-to-strict mode change during execution before DDL", async () => {
    const plan = await prepareOracleIndexPlan(target, ['DROP INDEX "APP"."IX_OLD";'], [drafts[0]!] as never);
    failEnhancedColumns = true;

    await expect(executeOracleIndexPlan(plan, 10, () => true)).rejects.toThrow("Index metadata changed");

    expect(ddl).toHaveLength(0);
  });

  it("rejects a live column semantic change from the fixed load baseline before DDL", async () => {
    const baseline = await readOracleIndexSnapshot(target);
    const context = {
      baseline: { snapshot: baseline, epoch: 1, targetIdentity: "target", requestId: 1, connectionRevision: 1, configFingerprint: "config", columnsFingerprint: "columns", indexesFingerprint: "indexes" },
      columnsFingerprint: "columns",
      indexesFingerprint: "indexes",
    };
    columnFlags.set("EMAIL", ["C", "100", "YES", "NO"]);

    await expect(prepareOracleIndexPlan(target, [], [], context)).rejects.toThrow("Index metadata changed");

    expect(ddl).toHaveLength(0);
  });

  it("matches loaded column definitions against complete enhanced semantics", async () => {
    const snapshot = await readOracleIndexSnapshot(target);
    const loaded = [{ name: "EMAIL", data_type: "VARCHAR2(100 BYTE)", is_nullable: true, numeric_precision: null, numeric_scale: null, character_maximum_length: 100 }];

    expect(oracleIndexSnapshotMatchesLoadedColumns(snapshot, loaded)).toBe(true);
    expect(oracleIndexSnapshotMatchesLoadedColumns(snapshot, [{ ...loaded[0]!, data_type: "VARCHAR2(100 CHAR)" }])).toBe(false);
  });

  it("strict-base loading still matches known precision and byte length fields", async () => {
    failEnhancedColumns = true;
    indexColumns = [
      ["AMOUNT", "NUMBER", null, 10, 0, "N"],
      ["RATE", "FLOAT", null, 126, null, "Y"],
      ["PAYLOAD", "RAW", 8, null, null, "Y"],
    ];
    const snapshot = await readOracleIndexSnapshot(target);
    const loaded = [
      { name: "AMOUNT", data_type: "NUMBER(5)", is_nullable: false, numeric_precision: 5, numeric_scale: 0, character_maximum_length: null },
      { name: "RATE", data_type: "FLOAT(20)", is_nullable: true, numeric_precision: 20, numeric_scale: null, character_maximum_length: null },
      { name: "PAYLOAD", data_type: "RAW(4)", is_nullable: true, numeric_precision: null, numeric_scale: null, character_maximum_length: null },
    ];

    expect(oracleIndexSnapshotMatchesLoadedColumns(snapshot, loaded)).toBe(false);
    expect(
      oracleIndexSnapshotMatchesLoadedColumns(snapshot, [
        { ...loaded[0]!, data_type: "NUMBER(10)", numeric_precision: 10 },
        { ...loaded[1]!, data_type: "FLOAT(126)", numeric_precision: 126 },
        { ...loaded[2]!, data_type: "RAW(8)" },
      ]),
    ).toBe(true);
    expect(
      oracleIndexSnapshotMatchesLoadedColumns(snapshot, [
        { ...loaded[0]!, data_type: "NUMBER(5)", numeric_precision: 5 },
        { ...loaded[1]!, data_type: "FLOAT(126)", numeric_precision: 126 },
        { ...loaded[2]!, data_type: "RAW(8)" },
      ]),
    ).toBe(false);
    expect(
      oracleIndexSnapshotMatchesLoadedColumns(snapshot, [
        { ...loaded[0]!, data_type: "NUMBER(10)", numeric_precision: 10 },
        { ...loaded[1]!, data_type: "FLOAT(126)", numeric_precision: 126 },
        { ...loaded[2]!, data_type: "RAW(4)" },
      ]),
    ).toBe(false);
    expect(
      oracleIndexSnapshotMatchesLoadedColumns(snapshot, [
        { ...loaded[0]!, data_type: "NUMBER(10)", numeric_precision: 10 },
        { ...loaded[1]!, data_type: "FLOAT(20)", numeric_precision: 20 },
        { ...loaded[2]!, data_type: "RAW(8)" },
      ]),
    ).toBe(false);
  });

  it("matches OceanBase RAW length formatting from the actual agent contract", async () => {
    indexColumns = [["PAYLOAD", "RAW", 8, null, null, "Y"]];
    const snapshot = await readOracleIndexSnapshot(target);
    const loaded = [{ name: "PAYLOAD", data_type: "RAW(8)", is_nullable: true, numeric_precision: null, numeric_scale: null, character_maximum_length: null }];

    expect(oracleIndexSnapshotMatchesLoadedColumns(snapshot, loaded)).toBe(true);
    expect(oracleIndexSnapshotMatchesLoadedColumns(snapshot, [{ ...loaded[0]!, data_type: "RAW(4)" }])).toBe(false);
  });

  it("stops before a later DROP when its constraint-support relation changes", async () => {
    indexNames = ["IX_OLD", "IX_SECOND"];
    const second = {
      ...drafts[0]!,
      id: "second",
      name: "IX_SECOND",
      original: { ...drafts[0]!.original, name: "IX_SECOND" },
    };
    const plan = await prepareOracleIndexPlan(target, ['DROP INDEX "APP"."IX_OLD";', 'DROP INDEX "APP"."IX_SECOND";'], [drafts[0]!, second] as never);

    const result = await executeOracleIndexPlan(plan, 10, () => true);

    expect(ddl).toEqual(['DROP INDEX "APP"."IX_OLD"']);
    expect(result?.steps.map((step) => step.state)).toEqual(["committed", "notExecuted"]);
    expect(result?.readbackError).toContain("support changed");
  });
});
