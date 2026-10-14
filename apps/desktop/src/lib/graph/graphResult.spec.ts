import { describe, expect, it } from "vitest";
import { extractGraphCells, graphResultRows, mergeGraphResults, type GraphEdge, type GraphNode } from "./graphResult";
import type { QueryResult } from "@/types/database";

const a: GraphNode = { id: "a", vid: { type: "string", value: "a" }, labels: ["Person"], properties: [{ owner: "Person", name: "name", type: "string", value: "Ada" }] };
const b: GraphNode = { id: "b", vid: { type: "string", value: "b" }, labels: [], properties: [] };
const edge: GraphEdge = { id: "e", source: "a", target: "b", sourceVid: a.vid, targetVid: b.vid, type: "WORK_IN", rank: "0", properties: [] };

function result(rows: unknown[][]): QueryResult {
  return { columns: ["entity"], rows: rows as QueryResult["rows"], affected_rows: 0, execution_time_ms: 0 };
}

describe("graph result transport", () => {
  it("extracts a typed graph cell while keeping the table display and is idempotent", () => {
    const page = result([[{ __dbx_graph_cell: "nebula-v1", kind: "edge", display: "[:WORK_IN]", nodes: [a, b], edges: [edge] }], ["scalar"]]);
    extractGraphCells(page);
    expect(page.rows).toEqual([["[:WORK_IN]"], ["scalar"]]);
    expect(page.graph_data?.nodes).toHaveLength(2);
    expect(page.graph_data?.cells).toEqual([{ row: 0, column: 0, kind: "edge", nodeIds: ["a", "b"], edgeIds: ["e"] }]);
    extractGraphCells(page);
    expect(page.graph_data?.cells).toHaveLength(1);
  });

  it("deduplicates nodes and offsets cell references across pages", () => {
    const first = extractGraphCells(result([[{ __dbx_graph_cell: "nebula-v1", kind: "vertex", display: "(a)", nodes: [b], edges: [] }]]));
    const second = extractGraphCells(result([[{ __dbx_graph_cell: "nebula-v1", kind: "path", display: "<path>", nodes: [a, b], edges: [edge] }]]));
    const merged = mergeGraphResults(first.graph_data, second.graph_data, 1);
    expect(merged?.nodes).toHaveLength(2);
    expect(merged?.nodes.find((node) => node.id === "a")?.properties[0].value).toBe("Ada");
    expect(merged?.cells.map((cell) => cell.row)).toEqual([0, 1]);
    expect(graphResultRows(second.graph_data, 0)).toEqual({ nodes: [], edges: [], cells: [] });
  });

  it("combines Tag properties for the same NebulaGraph VID", () => {
    const otherTag: GraphNode = { ...a, labels: ["Employee"], properties: [{ owner: "Employee", name: "role", type: "string", value: "Engineer" }] };
    const merged = mergeGraphResults({ nodes: [a], edges: [], cells: [] }, { nodes: [otherTag], edges: [], cells: [] });
    expect(merged?.nodes[0].labels).toEqual(["Person", "Employee"]);
    expect(merged?.nodes[0].properties.map((property) => `${property.owner}.${property.name}`)).toEqual(["Person.name", "Employee.role"]);
  });
});
