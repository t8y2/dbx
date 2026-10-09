import { computed, effectScope, ref } from "vue";
import { describe, expect, it } from "vitest";
import { useNeo4jNodeTableResult } from "@/composables/useNeo4jNodeTableResult";
import { extractNeo4jNodeCells, projectNeo4jNodeResult } from "@/lib/neo4j/neo4jNodeResult";
import { appendQueryResultSegment } from "@/stores/queryStore";
import type { QueryResult } from "@/types/database";
import { extractGraphCells, type GraphNode, type GraphProperty } from "./graphResult";
import { applyNeo4jGraphPropertyToResult } from "./neo4jGraph";

function vertex(id: string, name: string, age = "9007199254740993") {
  const node: GraphNode = {
    id,
    vid: { type: "neo4j-element-id", value: id },
    labels: ["Person"],
    properties: [
      { owner: "", name: "name", type: "string", value: name },
      { owner: "", name: "age", type: "int", value: age },
      { owner: "", name: "active", type: "bool", value: true },
    ],
  };
  return {
    __dbx_graph_cell: "neo4j-v1",
    __dbx_neo4j_node: "v1",
    kind: "vertex",
    display: `(:Person {name: "${name}"})`,
    nodes: [node],
    edges: [],
    properties: [
      { name: "name", type: "String", value: name },
      { name: "age", type: "Integer", value: age },
      { name: "active", type: "Boolean", value: "true" },
    ],
  };
}

function page(rows: unknown[][]): QueryResult {
  return { columns: ["p", "score"], rows: rows as QueryResult["rows"], affected_rows: 0, execution_time_ms: 1 };
}

function normalize(result: QueryResult): QueryResult {
  extractNeo4jNodeCells(result);
  return extractGraphCells(result);
}

describe("Neo4j graph and node-table compatibility", () => {
  it("retains both wire contracts, exact properties, scalar columns, and idempotent extraction", () => {
    const cell = vertex("qa-a", "QA Alice");
    const result = page([[cell, "7"]]);
    extractNeo4jNodeCells(result);
    extractNeo4jNodeCells(result);
    expect(result.neo4j_node_cells).toHaveLength(1);
    expect(result.rows[0]?.[0]).toEqual(cell);
    extractGraphCells(result);
    normalize(result);
    expect(result.graph_data?.nodes).toHaveLength(1);
    expect(result.graph_data?.cells).toHaveLength(1);
    const projected = projectNeo4jNodeResult(result);
    expect(projected.columns).toEqual(["p", "score", "p.name", "p.age", "p.active"]);
    expect(projected.rows).toEqual([[cell.display, "7", "QA Alice", "9007199254740993", "true"]]);
    expect(projected.hidden_column_indexes).toEqual([0]);
    expect(result.columns).toEqual(["p", "score"]);
    expect(result.rows).toEqual([[cell.display, "7"]]);
  });

  it("keeps both metadata streams aligned across raw cursor pages and clips both at the cap", () => {
    const first = normalize(page([[vertex("qa-a", "QA Alice"), "1"]]));
    const combined = appendQueryResultSegment(
      first,
      page([
        [vertex("qa-b", "QA Bob"), "2"],
        [vertex("qa-omitted", "QA Omitted"), "3"],
      ]),
      2,
    );
    expect(combined.rows).toHaveLength(2);
    expect(combined.graph_data?.cells.map((cell) => cell.row)).toEqual([0, 1]);
    expect(combined.graph_data?.nodes.map((node) => node.id)).toEqual(["qa-a", "qa-b"]);
    expect(combined.neo4j_node_cells?.map((cell) => cell.row_index)).toEqual([0, 1]);
    expect(projectNeo4jNodeResult(combined).rows.map((row) => row[2])).toEqual(["QA Alice", "QA Bob"]);
    expect(appendQueryResultSegment(first, page([[vertex("qa-b", "QA Bob"), "2"]]), 1).neo4j_node_cells).toHaveLength(1);
  });

  it("updates all matching aliases in the graph, reactive node grid and export, without touching other nodes", () => {
    const scope = effectScope();
    const source = ref(
      normalize(
        page([
          [vertex("qa-a", "QA Alice"), "1"],
          [vertex("qa-a", "QA Alice"), "2"],
          [vertex("qa-b", "QA Bob", "42"), "3"],
        ]),
      ),
    );
    const table = scope.run(() =>
      useNeo4jNodeTableResult(
        computed(() => source.value),
        computed(() => "qa-result"),
      ),
    )!;
    expect(table.result.value?.rows.map((row) => row[2])).toEqual(["QA Alice", "QA Alice", "QA Bob"]);
    const node = source.value.graph_data!.nodes[0]!;
    for (const [name, value] of [
      ["name", "QA Updated"],
      ["age", "9007199254740994"],
      ["active", false],
    ] as const) {
      const property = node.properties.find((property) => property.name === name)!;
      applyNeo4jGraphPropertyToResult(source.value, node, property, { ...property, value } as GraphProperty);
    }
    expect(table.result.value?.rows.map((row) => row.slice(2))).toEqual([
      ["QA Updated", "9007199254740994", "false"],
      ["QA Updated", "9007199254740994", "false"],
      ["QA Bob", "42", "true"],
    ]);
    expect(projectNeo4jNodeResult(source.value).rows).toEqual(table.result.value?.rows);
    table.setSort("p.age", 3, "asc");
    expect(table.result.value?.rows[0]?.[2]).toBe("QA Bob");
    expect(source.value.graph_data?.nodes[0]?.properties.find((property) => property.name === "age")?.value).toBe("9007199254740994");
    expect(source.value.graph_data?.cells.map((cell) => cell.row)).toEqual([0, 1, 2]);
    scope.stop();
  });

  it("normalizes old node envelopes and malformed optional graph metadata without leaving object cells", () => {
    const cell = vertex("qa-a", "QA Alice");
    const result = normalize(
      page([
        [{ ...cell, nodes: null }, "1"],
        [{ __dbx_neo4j_node: "v1", display: "(:Person)", properties: [] }, "2"],
      ]),
    );
    expect(result.rows).toEqual([
      [cell.display, "1"],
      ["(:Person)", "2"],
    ]);
    expect(result.neo4j_node_cells).toHaveLength(2);
    expect(result.graph_data).toBeUndefined();
  });
});
