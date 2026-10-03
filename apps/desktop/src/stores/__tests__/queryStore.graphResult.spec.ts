import { describe, expect, it } from "vitest";
import { appendQueryResultSegment } from "@/stores/queryStore";
import { extractGraphCells, type GraphNode } from "@/lib/graph/graphResult";
import { extractNeo4jNodeCells, projectNeo4jNodeResult } from "@/lib/neo4j/neo4jNodeResult";
import type { QueryResult } from "@/types/database";

const node: GraphNode = { id: "node-a", vid: { type: "string", value: "a" }, labels: ["Person"], properties: [] };

function page(text: string): QueryResult {
  return {
    columns: ["vertex"],
    rows: [[{ __dbx_graph_cell: "nebula-v1", kind: "vertex", display: text, nodes: [node], edges: [] }]] as unknown as QueryResult["rows"],
    affected_rows: 0,
    execution_time_ms: 1,
  };
}

describe("query result graph paging", () => {
  it("keeps table cells scalar and offsets graph references when a page is appended", () => {
    const first = extractGraphCells(page("(a)"));
    const combined = appendQueryResultSegment(first, page("(a :Person)"), 2);
    expect(combined.rows).toEqual([["(a)"], ["(a :Person)"]]);
    expect(combined.graph_data?.nodes).toHaveLength(1);
    expect(combined.graph_data?.cells.map((cell) => cell.row)).toEqual([0, 1]);
    expect(combined.neo4j_node_cells).toBeUndefined();
    expect(appendQueryResultSegment(first, page("ignored"), 1).graph_data?.cells).toHaveLength(1);
  });

  it("normalizes a raw Nebula page without creating Neo4j node metadata", () => {
    const empty: QueryResult = { ...page("unused"), rows: [] };
    const result = appendQueryResultSegment(empty, page("(a :Person)"), 2);
    expect(result.rows).toEqual([["(a :Person)"]]);
    expect(result.graph_data?.cells).toEqual([{ row: 0, column: 0, kind: "vertex", nodeIds: ["node-a"], edgeIds: [] }]);
    expect(result.neo4j_node_cells).toBeUndefined();
  });

  it("keeps Neo4j node properties and capped row offsets when graph extraction is also active", () => {
    const neo4jPage = (names: string[]): QueryResult => ({
      columns: ["n"],
      rows: names.map((name) => [{ __dbx_neo4j_node: "v1", display: `(:Person {name: "${name}"})`, properties: [{ name: "name", type: "String", value: name }] }]) as unknown as QueryResult["rows"],
      affected_rows: 0,
      execution_time_ms: 1,
    });
    const first = neo4jPage(["QA Alice"]);
    extractNeo4jNodeCells(first);
    const combined = appendQueryResultSegment(first, neo4jPage(["QA Bob", "QA Omitted"]), 2);
    expect(combined.columns).toEqual(["n"]);
    expect(combined.rows).toEqual([['(:Person {name: "QA Alice"})'], ['(:Person {name: "QA Bob"})']]);
    expect(combined.neo4j_node_cells?.map((cell) => cell.row_index)).toEqual([0, 1]);
    expect(combined.neo4j_node_cells?.map((cell) => cell.properties[0].value)).toEqual(["QA Alice", "QA Bob"]);
    expect(combined.graph_data).toBeUndefined();
    const projected = projectNeo4jNodeResult(combined);
    expect(projected.columns).toEqual(["n", "n.name"]);
    expect(projected.rows.map((row) => row[1])).toEqual(["QA Alice", "QA Bob"]);
    expect(appendQueryResultSegment(first, neo4jPage(["QA Omitted"]), 1).neo4j_node_cells).toHaveLength(1);
  });
});
