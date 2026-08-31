import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/types/database";
import {
  doltAddAllSql,
  doltCheckoutBranchSql,
  doltCommitSql,
  doltCreateBranchSql,
  doltCreateTagSql,
  doltClientSessionScope,
  doltDeleteBranchSql,
  doltDeleteTagSql,
  doltDiffSummarySql,
  doltDiscardWorkingTreeSql,
  doltGraphEdgePath,
  doltGraphEdgeRoute,
  doltHardResetSql,
  doltLogSql,
  doltMergeBranchSql,
  doltRevertCommitSql,
  doltRefColorIndexes,
  doltRefsByCommit,
  doltStatusSql,
  doltTableChangeFlags,
  doltTableChangeKind,
  doltTableChangeSymbol,
  doltTableDiffCountSql,
  doltTableDiffSql,
  layoutDoltCommitGraph,
  parseDoltBranches,
  parseDoltCommits,
  parseDoltRowDiff,
  parseDoltStatus,
  parseDoltTableChanges,
  parseDoltTags,
} from "@/lib/dolt/doltVersionControl";

function result(columns: string[], rows: QueryResult["rows"]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 1 };
}

describe("doltVersionControl", () => {
  it("quotes revision and table arguments in generated SQL", () => {
    expect(doltLogSql("feature/o'hare", 10)).toBe("SELECT * FROM DOLT_LOG('feature/o''hare', '--parents', '--decorate', 'short') LIMIT 10");
    expect(doltLogSql("feature\\o'hare", 10)).toBe("SELECT * FROM DOLT_LOG('feature\\\\o''hare', '--parents', '--decorate', 'short') LIMIT 10");
    expect(doltStatusSql()).toBe("SELECT table_name, staged, status FROM dolt_status ORDER BY table_name, staged DESC");
    expect(doltAddAllSql()).toBe("CALL DOLT_ADD('.')");
    expect(doltCommitSql("fix user's row")).toBe("CALL DOLT_COMMIT('-m', 'fix user''s row')");
    expect(doltDiffSummarySql("main", "release'1")).toBe("SELECT * FROM DOLT_DIFF_SUMMARY('main', 'release''1')");
    expect(doltTableDiffSql("HEAD", "WORKING", "order'items", 25)).toBe("SELECT * FROM DOLT_DIFF('HEAD', 'WORKING', 'order''items') LIMIT 25");
    expect(doltTableDiffSql("HEAD", "WORKING", "order'items", 25, 50)).toBe("SELECT * FROM DOLT_DIFF('HEAD', 'WORKING', 'order''items') LIMIT 25 OFFSET 50");
    expect(doltTableDiffCountSql("HEAD", "WORKING", "order'items")).toBe("SELECT COUNT(*) AS row_count FROM DOLT_DIFF('HEAD', 'WORKING', 'order''items')");
    expect(doltCreateBranchSql("feature/o'hare", "HEAD")).toBe("CALL DOLT_BRANCH('feature/o''hare', 'HEAD')");
    expect(doltMergeBranchSql("release'1")).toBe("CALL DOLT_MERGE('release''1')");
    expect(doltCheckoutBranchSql("feature/o'hare")).toBe("CALL DOLT_CHECKOUT('feature/o''hare')");
    expect(doltRevertCommitSql("abc'123")).toBe("CALL DOLT_REVERT('abc''123')");
    expect(doltHardResetSql("abc'123")).toBe("CALL DOLT_RESET('--hard', 'abc''123')");
    expect(doltDiscardWorkingTreeSql()).toBe("CALL DOLT_RESET('--hard', 'HEAD')");
    expect(doltCreateTagSql("v1'o", "HEAD")).toBe("CALL DOLT_TAG('v1''o', 'HEAD')");
    expect(doltDeleteTagSql("v0'o")).toBe("CALL DOLT_TAG('-d', 'v0''o')");
    expect(doltDeleteBranchSql("old'branch")).toBe("CALL DOLT_BRANCH('-d', 'old''branch')");
  });

  it("builds database-scoped client sessions", () => {
    expect(doltClientSessionScope("connection-1", "database_a")).toEqual({
      connectionId: "connection-1",
      database: "database_a",
      clientSessionId: "dolt-version-control:connection-1:database_a",
    });
    expect(doltClientSessionScope("connection-1", "database_b").clientSessionId).not.toBe(doltClientSessionScope("connection-1", "database_a").clientSessionId);
  });

  it("parses staged and unstaged working tree changes", () => {
    const changes = parseDoltStatus(
      result(
        ["status", "table_name", "staged"],
        [
          ["modified", "orders", true],
          ["new table", "customers", 0],
        ],
      ),
    );

    expect(changes).toEqual([
      { tableName: "orders", staged: true, status: "modified" },
      { tableName: "customers", staged: false, status: "new table" },
    ]);
  });

  it("parses Dolt refs, commits, decorations, and table changes by column name", () => {
    const branchRows = result(["hash", "name"], [["abc123", "main"]]);
    const tagRows = result(["tag_hash", "tag_name"], [["abc123", "v1.0"]]);
    const commitRows = result(["commit_hash", "parents", "committer", "email", "date", "message", "refs"], [["abc123", "def456, 789abc", "Ada", "ada@example.com", "2026-08-17", "Ship it", "HEAD -> main, tag: v1.0"]]);
    const changeRows = result(["to_table_name", "from_table_name", "diff_type", "data_change", "schema_change"], [["orders", "orders", "modified", 1, 0]]);

    const branches = parseDoltBranches(branchRows, "main");
    const tags = parseDoltTags(tagRows);
    const commits = parseDoltCommits(commitRows);

    expect(branches).toEqual([{ name: "main", hash: "abc123", kind: "branch", active: true }]);
    expect(tags[0]).toMatchObject({ name: "v1.0", hash: "abc123", kind: "tag" });
    expect(commits[0]).toMatchObject({ hash: "abc123", parents: ["def456", "789abc"], committer: "Ada", message: "Ship it" });
    expect(commits[0].refs).toEqual(["main", "tag: v1.0"]);
    expect(parseDoltTableChanges(changeRows)).toEqual([{ tableName: "orders", fromTableName: "orders", toTableName: "orders", diffType: "modified", dataChange: true, schemaChange: false }]);
    expect(
      doltRefsByCommit(commits, [...branches, ...tags])
        .get("abc123")
        ?.map((item) => item.name),
    ).toEqual(["main", "v1.0"]);
  });

  it("classifies table changes with reference-style symbols and flags", () => {
    const added = { diffType: "CREATE", dataChange: false, schemaChange: true } as const;
    const removed = { diffType: "deleted", dataChange: true, schemaChange: true } as const;
    const modified = { diffType: "modified", dataChange: true, schemaChange: false } as const;
    const schemaOnly = { diffType: "modified", dataChange: false, schemaChange: true } as const;
    const metadataOnly = { diffType: "modified", dataChange: false, schemaChange: false } as const;

    expect(doltTableChangeKind(added)).toBe("added");
    expect(doltTableChangeSymbol(added)).toBe("+");
    expect(doltTableChangeFlags(added)).toEqual(["schema"]);

    expect(doltTableChangeKind(removed)).toBe("removed");
    expect(doltTableChangeSymbol(removed)).toBe("-");
    expect(doltTableChangeFlags(removed)).toEqual(["data", "schema"]);

    expect(doltTableChangeKind(modified)).toBe("modified");
    expect(doltTableChangeSymbol(modified)).toBe("*");
    expect(doltTableChangeFlags(modified)).toEqual(["data"]);

    expect(doltTableChangeKind(schemaOnly)).toBe("schema");
    expect(doltTableChangeSymbol(schemaOnly)).toBe("*");
    expect(doltTableChangeFlags(schemaOnly)).toEqual(["schema"]);

    expect(doltTableChangeKind(metadataOnly)).toBe("modified");
    expect(doltTableChangeFlags(metadataOnly)).toEqual(["metadata"]);
  });

  it("assigns stable lanes to a merge history", () => {
    const commits = [
      { hash: "merge", parents: ["main-parent", "feature-parent"], committer: "", email: "", date: "", message: "merge", refs: ["HEAD -> main"] },
      { hash: "main-parent", parents: ["root"], committer: "", email: "", date: "", message: "main", refs: [] },
      { hash: "feature-parent", parents: ["root"], committer: "", email: "", date: "", message: "feature", refs: ["feature"] },
      { hash: "root", parents: [], committer: "", email: "", date: "", message: "root", refs: ["tag: v1"] },
    ];
    const refs = [
      { name: "main", hash: "merge", kind: "branch" as const, active: true },
      { name: "feature", hash: "feature-parent", kind: "branch" as const, active: false },
      { name: "v1", hash: "root", kind: "tag" as const, active: false },
    ];

    const layout = layoutDoltCommitGraph(commits, refs, "main");
    expect(layout.laneCount).toBeGreaterThanOrEqual(2);
    expect(layout.rows.map((row) => row.lane)).toEqual([0, 0, 1, 0]);
    expect(layout.rows.map((row) => row.nodeRef)).toEqual(["main", "main", "feature", "v1"]);
    expect(layout.rows[0].edges).toEqual([
      { fromLane: 0, toLane: 0, colorLane: 0, colorRef: "main" },
      { fromLane: 0, toLane: 1, colorLane: 1, colorRef: "feature" },
    ]);
    expect(layout.rows[1].edges).toContainEqual({ fromLane: 1, toLane: 1, colorLane: 1, colorRef: "feature" });
    expect(layout.rows[2].edges).toContainEqual({ fromLane: 1, toLane: 0, colorLane: 1, colorRef: "feature" });
  });

  it("keeps the active branch first-parent chain in lane zero when side commits are interleaved", () => {
    const commits = [
      { hash: "merge", parents: ["main-2", "feature-2"], committer: "", email: "", date: "", message: "merge", refs: ["HEAD -> main"] },
      { hash: "feature-2", parents: ["feature-1"], committer: "", email: "", date: "", message: "feature 2", refs: ["feature"] },
      { hash: "main-2", parents: ["root"], committer: "", email: "", date: "", message: "main 2", refs: [] },
      { hash: "feature-1", parents: ["root"], committer: "", email: "", date: "", message: "feature 1", refs: [] },
      { hash: "root", parents: [], committer: "", email: "", date: "", message: "root", refs: [] },
    ];
    const refs = [
      { name: "main", hash: "merge", kind: "branch" as const, active: true },
      { name: "feature", hash: "feature-2", kind: "branch" as const, active: false },
    ];

    expect(layoutDoltCommitGraph(commits, refs, "main").rows.map((row) => row.lane)).toEqual([0, 1, 0, 1, 0]);
  });

  it("starts fork edges at the real parent and ends merge edges at the merge commit", () => {
    expect(doltGraphEdgeRoute(0, 0, 3, 2)).toBe("direct");
    expect(doltGraphEdgeRoute(0, 1, 1, 2)).toBe("direct");
    expect(doltGraphEdgeRoute(0, 1, 3, 1)).toBe("fork");
    expect(doltGraphEdgeRoute(0, 1, 3, 2)).toBe("merge");
    expect(doltGraphEdgePath(18, 105, 18, 15)).toBe("M 18 105 L 18 15");
    expect(doltGraphEdgePath(18, 105, 36, 15, "fork")).toBe("M 18 105 L 36 75 L 36 15");
    expect(doltGraphEdgePath(18, 105, 54, 15, "fork")).toBe("M 18 105 L 54 75 L 54 15");
    expect(doltGraphEdgePath(18, 105, 36, 15, "merge")).toBe("M 18 105 L 18 45 L 36 15");
    expect(doltGraphEdgePath(18, 105, 54, 15, "merge")).toBe("M 18 105 L 18 45 L 54 15");
    expect(doltGraphEdgePath(18, 45, 36, 15)).toBe("M 18 45 L 36 15");
  });

  it("deduplicates log decorations against branch and tag records", () => {
    const commits = [{ hash: "abc123", parents: [], committer: "", email: "", date: "", message: "", refs: ["HEAD -> main", "tag: v1.0", "refs/tags/v2.0"] }];
    const refs = [
      { name: "main", hash: "abc123", kind: "branch" as const, active: true },
      { name: "v1.0", hash: "abc123", kind: "tag" as const, active: false },
    ];

    expect(doltRefsByCommit(commits, refs).get("abc123")).toEqual([refs[0], refs[1], { name: "v2.0", hash: "abc123", kind: "tag", active: false }]);
  });

  it("assigns ref colors independently of query order", () => {
    const first = doltRefColorIndexes(["main", "feature", "v1.0"], 18);
    const second = doltRefColorIndexes(["v1.0", "main", "feature"], 18);

    expect([...first]).toEqual([...second]);
    expect(new Set(first.values()).size).toBe(3);
  });

  it("pairs from/to diff columns and infers row changes", () => {
    const parsed = parseDoltRowDiff(
      result(
        ["from_id", "to_id", "from_name", "to_name", "diff_type", "commit_hash"],
        [
          [null, 1, null, "Ada", "added", "abc"],
          [2, 2, "Old", "New", "modified", "def"],
          [3, null, "Removed", null, "removed", "ghi"],
        ],
      ),
    );
    expect(parsed.columns).toEqual(["id", "name"]);
    expect(parsed.columnKinds).toEqual(["unchanged", "unchanged"]);
    expect(parsed.rows).toEqual([
      { kind: "added", before: [null, null], after: [1, "Ada"], changedColumns: ["id", "name"] },
      { kind: "modified", before: [2, "Old"], after: [2, "New"], changedColumns: ["name"] },
      { kind: "removed", before: [3, "Removed"], after: [null, null], changedColumns: ["id", "name"] },
    ]);
  });

  it("accepts qualified, quoted, and suffix-style diff columns", () => {
    const parsed = parseDoltRowDiff(result(["d.`id_from`", "d.`id_to`", '"from_name"', '"to_name"', "d.diff_type"], [[1, 1, "Old", "New", "modified"]]));

    expect(parsed).toEqual({
      columns: ["id", "name"],
      columnKinds: ["unchanged", "unchanged"],
      rows: [{ kind: "modified", before: [1, "Old"], after: [1, "New"], changedColumns: ["name"] }],
    });
  });

  it("keeps schema-only columns aligned and identifies additions and removals", () => {
    const parsed = parseDoltRowDiff(result(["from_id", "to_id", "from_legacy", "to_created_at", "diff_type"], [[1, 1, "old", "new", "modified"]]));

    expect(parsed).toEqual({
      columns: ["id", "legacy", "created_at"],
      columnKinds: ["unchanged", "removed", "added"],
      rows: [{ kind: "modified", before: [1, "old", null], after: [1, null, "new"], changedColumns: ["legacy", "created_at"] }],
    });
  });

  it("infers schema columns when Dolt returns both sides with one side empty", () => {
    const parsed = parseDoltRowDiff(result(["from_id", "to_id", "from_legacy", "to_legacy", "from_created_at", "to_created_at", "diff_type"], [[1, 1, "old", null, null, "new", "modified"]]), true);

    expect(parsed.columnKinds).toEqual(["unchanged", "removed", "added"]);
  });
});
