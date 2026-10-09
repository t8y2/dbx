import { describe, expect, it } from "vitest";
import { applyNeo4jGraphPropertyToResult, buildNeo4jGraphExpand, buildNeo4jGraphPropertyUpdate } from "./neo4jGraph";
import { extractGraphCells, graphPropertyFromUpdateResult, type GraphEdge, type GraphNode } from "./graphResult";
import { graphAdapterForDatabase } from "./graphAdapters";
import type { QueryResult } from "@/types/database";

const node: GraphNode = { id: "n", vid: { type: "neo4j-element-id", value: "4:sample:1" }, labels: ["Person"], properties: [{ owner: "", name: "age", type: "int", value: "9007199254740993" }] };
const edge: GraphEdge = { id: "r", vid: { type: "neo4j-element-id", value: "5:sample:1" }, source: "n", target: "m", sourceVid: node.vid, targetVid: { type: "neo4j-element-id", value: "4:sample:2" }, type: "KNOWS", properties: [{ owner: "", name: "active", type: "bool", value: true }] };

describe("Neo4j graph adapter", () => {
  it("retains double precision while Nebula uses its single-precision comparison", () => {
    const returned = { owner: "", name: "weight", type: "float", value: "3.1500000948905659" };
    expect(graphAdapterForDatabase("nebula")!.matchesPropertyValue(returned, "3.15")).toBe(true);
    expect(graphAdapterForDatabase("neo4j")!.matchesPropertyValue(returned, "3.15")).toBe(false);
    expect(graphAdapterForDatabase("neo4j")!.matchesPropertyValue({ ...returned, value: "3.15000010" }, "3.15000011")).toBe(false);
    expect(graphAdapterForDatabase("neo4j")!.matchesPropertyValue({ ...returned, value: "3.15" }, "3.15")).toBe(true);
  });
  it("keeps legacy byte text from corrupting JSON when another property is edited", () => {
    const binaryNode: GraphNode = {
      ...node,
      properties: [
        { owner: "", name: "bytes", type: "List", value: '\u0000binary"\\text' },
        { owner: "", name: "name", type: "string", value: "before" },
      ],
    };
    const result = extractGraphCells({ columns: ["nested"], rows: [[{ __dbx_graph_cell: "neo4j-v1", kind: "map", display: "before", nodes: [binaryNode], edges: [], displayParts: ['{"node":', { nodeId: "n" }, "}"] }]] as unknown as QueryResult["rows"], affected_rows: 0, execution_time_ms: 0 });
    applyNeo4jGraphPropertyToResult(result, binaryNode, binaryNode.properties[1], { ...binaryNode.properties[1], value: "after" });
    expect(JSON.parse(String(result.rows[0][0])).node.properties).toEqual({ bytes: '\u0000binary"\\text', name: "after" });
  });

  it("preserves a normalized byte array and exact integer tokens after editing", () => {
    const binaryNode: GraphNode = {
      ...node,
      properties: [
        { owner: "", name: "bytes", type: "List", value: '["0","34","255"]' },
        { owner: "", name: "age", type: "int", value: "9007199254740993" },
      ],
    };
    const result = extractGraphCells({ columns: ["n"], rows: [[{ __dbx_graph_cell: "neo4j-v1", kind: "vertex", display: "before", nodes: [binaryNode], edges: [] }]] as unknown as QueryResult["rows"], affected_rows: 0, execution_time_ms: 0 });
    applyNeo4jGraphPropertyToResult(result, binaryNode, binaryNode.properties[1], { ...binaryNode.properties[1], value: "9007199254740994" });
    expect(result.rows[0][0]).toContain('"bytes":["0","34","255"]');
    expect(result.rows[0][0]).toContain('"age":9007199254740994');
  });
  it("updates nested graph references without parsing or rounding scalar JSON tokens", () => {
    const result = extractGraphCells({
      columns: ["nested"],
      rows: [[{ __dbx_graph_cell: "neo4j-v1", kind: "map", display: "before", nodes: [structuredClone(node)], edges: [structuredClone(edge)], displayParts: ['{"count":9007199254740997,"node":', { nodeId: "n" }, ',"edge":', { edgeId: "r" }, "}"] }]] as unknown as QueryResult["rows"],
      affected_rows: 0,
      execution_time_ms: 0,
    });
    applyNeo4jGraphPropertyToResult(result, node, node.properties[0], { ...node.properties[0], value: "9007199254740994" });
    expect(result.rows[0][0]).toContain('"count":9007199254740997');
    expect(result.rows[0][0]).toContain('"age":9007199254740994');
    applyNeo4jGraphPropertyToResult(result, edge, edge.properties[0], { ...edge.properties[0], value: false });
    expect(result.rows[0][0]).toContain('"active":false');
  });
  it("uses modern or legacy identities and preserves integer precision", () => {
    const statement = buildNeo4jGraphPropertyUpdate(node, node.properties[0], "9007199254740994");
    expect(statement).toContain('elementId(n) = "4:sample:1"');
    expect(statement).toContain("SET n.`age` = n.`age` WITH n WHERE n.`age` = 9007199254740993 SET n.`age` = 9007199254740994");
    expect(buildNeo4jGraphExpand({ ...node, vid: { type: "neo4j-id", value: "9007199254740993" } })).toBe("MATCH (n) WHERE id(n) = 9007199254740993 OPTIONAL MATCH (n)-[r]-(m) RETURN n, r, m LIMIT 200");
    expect(buildNeo4jGraphPropertyUpdate(edge, edge.properties[0], false)).toContain('elementId(r) = "5:sample:1" AND elementId(s) = "4:sample:1" AND elementId(t) = "4:sample:2"');
  });

  it("quotes user values and identifiers, rejects invalid numbers, and preserves float types", () => {
    const property = { owner: "", name: "odd`key", type: "string", value: "before" };
    expect(buildNeo4jGraphPropertyUpdate(node, property, 'after"\\\n')).toContain('SET n.`odd``key` = "after\\\"\\\\\\n"');
    expect(buildNeo4jGraphPropertyUpdate(node, { ...property, name: "weight", type: "float", value: "1.5" }, "2")).toContain('SET n.`weight` = toFloat("2")');
    for (const value of ["1; DELETE n", "9223372036854775808", "1.5"]) expect(() => buildNeo4jGraphPropertyUpdate(node, node.properties[0], value)).toThrow();
    expect(() => buildNeo4jGraphExpand({ ...node, vid: undefined })).toThrow();
  });

  it("keeps scalar results unchanged and refreshes direct graph cells after updates", () => {
    const result = extractGraphCells({ columns: ["n", "count"], rows: [[{ __dbx_graph_cell: "neo4j-v1", kind: "vertex", display: "before", nodes: [structuredClone(node)], edges: [] }, "12"]] as unknown as QueryResult["rows"], affected_rows: 0, execution_time_ms: 0 });
    expect(result.rows).toEqual([["before", "12"]]);
    const updated = graphPropertyFromUpdateResult({ columns: ["dbx_value"], rows: [["9007199254740994"]], affected_rows: 0, execution_time_ms: 0 }, node.properties[0]);
    applyNeo4jGraphPropertyToResult(result, node, node.properties[0], updated);
    expect(result.rows[0][0]).toBe('(:Person {"age":9007199254740994})');
    expect(result.graph_data?.nodes[0].properties[0].value).toBe("9007199254740994");
    expect(graphAdapterForDatabase("neo4j")?.buildExpand).toBe(buildNeo4jGraphExpand);
    expect(graphAdapterForDatabase("nebula")).toBeDefined();
    expect(graphAdapterForDatabase("mysql")).toBeUndefined();
  });
});
