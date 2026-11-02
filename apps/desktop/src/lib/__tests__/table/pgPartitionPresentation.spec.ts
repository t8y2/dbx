import { describe, expect, it } from "vitest";

import { flattenPgPartitionNodes, pgPartitionBoundText, pgPartitionKindLabelKey, pgPartitionNodeBoundText, pgPartitionRowHint, splitPgPartitionBoundValues, visiblePgPartitionRows } from "@/lib/table/pgPartitionPresentation";
import type { PgPartitionNode } from "@/types/database";

function node(name: string, children: PgPartitionNode[] = []): PgPartitionNode {
  return { schema: "public", name, isLeaf: children.length === 0, children };
}

describe("pgPartitionPresentation", () => {
  it("flattens a multi-level tree depth-first with nesting depth", () => {
    const tree = [node("logs", [node("logs_2024", [node("logs_2024_us")])]), node("logs_default")];

    expect(flattenPgPartitionNodes(tree).map(({ depth, node: rowNode }) => `${depth}:${rowNode.name}`)).toEqual(["0:logs", "1:logs_2024", "2:logs_2024_us", "0:logs_default"]);
  });

  it("carries the direct parent identity for nested partition operations", () => {
    const rows = flattenPgPartitionNodes([node("logs_2024", [node("logs_2024_cn")])], { schema: "public", name: "logs" });

    expect(rows.map((row) => ({ name: row.node.name, parentSchema: row.parentSchema, parentName: row.parentName }))).toEqual([
      { name: "logs_2024", parentSchema: "public", parentName: "logs" },
      { name: "logs_2024_cn", parentSchema: "public", parentName: "logs_2024" },
    ]);
  });
  it("gives every row a unique key", () => {
    const rows = flattenPgPartitionNodes([node("a"), node("b", [node("b1")])]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it("tracks depth and the ancestor key chain used to fold and indent a parent", () => {
    const rows = flattenPgPartitionNodes([node("p1", [node("p1a", [node("p1a1")])]), node("p2")]);

    expect(rows.map((row) => [row.node.name, row.depth, row.ancestorKeys])).toEqual([
      ["p1", 0, []],
      ["p1a", 1, ["public.p1"]],
      ["p1a1", 2, ["public.p1", "public.p1/public.p1a"]],
      ["p2", 0, []],
    ]);
  });

  it("hides every descendant of a collapsed parent", () => {
    const rows = flattenPgPartitionNodes([node("p1", [node("p1a"), node("p1b")]), node("p2")]);

    expect(visiblePgPartitionRows(rows, new Set()).map((row) => row.node.name)).toEqual(["p1", "p1a", "p1b", "p2"]);
    expect(visiblePgPartitionRows(rows, new Set(["public.p1"])).map((row) => row.node.name)).toEqual(["p1", "p2"]);
  });

  it("builds a row hover hint from the size and count estimates", () => {
    const t = (key: string, params?: Record<string, unknown>) => `${key}(${JSON.stringify(params)})`;
    const bytes = (value: number) => `${value}B`;

    expect(pgPartitionRowHint({ ...node("p"), rowEstimate: 366, totalBytes: 1048576 }, t, bytes)).toBe('structureEditor.partitionsRowEstimate({"count":366}) · structureEditor.partitionsSize({"size":"1048576B"})');
    expect(pgPartitionRowHint({ ...node("p"), rowEstimate: 5 }, t, bytes)).toBe('structureEditor.partitionsRowEstimate({"count":5})');
    expect(pgPartitionRowHint({ ...node("p"), totalBytes: 10 }, t, bytes)).toBe('structureEditor.partitionsSize({"size":"10B"})');
    // No estimates -> no tooltip at all.
    expect(pgPartitionRowHint(node("p"), t, bytes)).toBeUndefined();
  });

  it("renders each bound kind as its SQL fragment", () => {
    expect(pgPartitionBoundText({ kind: "range", from: ["'2024-01-01'"], to: ["'2025-01-01'"] })).toBe("FROM ('2024-01-01') TO ('2025-01-01')");
    expect(pgPartitionBoundText({ kind: "range", from: ["MINVALUE", "'a'"], to: ["MAXVALUE", "'b'"] })).toBe("FROM (MINVALUE, 'a') TO (MAXVALUE, 'b')");
    expect(pgPartitionBoundText({ kind: "list", values: ["'a'", "'b'"] })).toBe("IN ('a', 'b')");
    expect(pgPartitionBoundText({ kind: "hash", modulus: 2, remainder: 1 })).toBe("MODULUS 2 REMAINDER 1");
    expect(pgPartitionBoundText({ kind: "default" })).toBe("DEFAULT");
    expect(pgPartitionBoundText(undefined)).toBe("");
  });

  it("falls back to the raw catalog definition when the bound was not parsed", () => {
    expect(pgPartitionNodeBoundText({ ...node("p"), boundDefinition: "FOR VALUES IN (1)" })).toBe("FOR VALUES IN (1)");
    expect(pgPartitionNodeBoundText({ ...node("p"), bound: { kind: "default" }, boundDefinition: "DEFAULT" })).toBe("DEFAULT");
    expect(pgPartitionNodeBoundText(node("p"))).toBe("");
  });

  it("splits bound values on top-level commas only", () => {
    expect(splitPgPartitionBoundValues("1, 2, 3")).toEqual(["1", "2", "3"]);
    expect(splitPgPartitionBoundValues("'a,b', 'c'")).toEqual(["'a,b'", "'c'"]);
    expect(splitPgPartitionBoundValues("lower('A''B'), lower('C')")).toEqual(["lower('A''B')", "lower('C')"]);
    expect(splitPgPartitionBoundValues("  '2024-01-01'  ")).toEqual(["'2024-01-01'"]);
    expect(splitPgPartitionBoundValues("")).toEqual([]);
    expect(splitPgPartitionBoundValues(" , ")).toEqual([]);
  });

  it("maps strategies to translation keys", () => {
    expect(pgPartitionKindLabelKey("range")).toBe("structureEditor.partitionKindRange");
    expect(pgPartitionKindLabelKey("list")).toBe("structureEditor.partitionKindList");
    expect(pgPartitionKindLabelKey("hash")).toBe("structureEditor.partitionKindHash");
    expect(pgPartitionKindLabelKey(undefined)).toBeUndefined();
  });
});
