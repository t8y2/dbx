import { describe, expect, it } from "vitest";
import { applyGraphPropertyToResult, buildNebulaGraphExpand, buildNebulaGraphPropertyUpdate, graphPropertyFromUpdateResult, graphPropertyMatchesValue } from "./nebulaGraph";
import { extractGraphCells, type GraphEdge, type GraphNode, type GraphProperty } from "./graphResult";
import type { QueryResult } from "@/types/database";

const node: GraphNode = { id: "n", vid: { type: "string", value: 'a"b' }, labels: ["Person"], properties: [{ owner: "Person", name: "age", type: "int", value: "9007199254740993" }] };
const edge: GraphEdge = { id: "e", source: "n", target: "m", sourceVid: node.vid, targetVid: { type: "string", value: "company" }, type: "WORK_IN", rank: "-2", properties: [{ owner: "", name: "active", type: "bool", value: true }] };

describe("Nebula graph actions", () => {
  it("refreshes every ordered graph reference inside paths, lists, sets, and maps", () => {
    const vertex = structuredClone(node);
    const relationship = structuredClone(edge);
    const cells = [
      { kind: "path", displayParts: ["<", { nodeId: "n" }, "-", { edgeId: "e", path: true }, "->", { nodeId: "n" }, ">"] },
      { kind: "list", displayParts: ["[", { nodeId: "n" }, ', "literal(n):9007199254740999", ', { edgeId: "e" }, "]"] },
      { kind: "set", displayParts: ["{", { edgeId: "e" }, ", ", { nodeId: "n" }, "}"] },
      { kind: "map", displayParts: ["{nested: [", { nodeId: "n" }, ", ", { nodeId: "n" }, "], large: 9007199254740999}"] },
    ];
    const result = extractGraphCells({
      columns: ["path", "list", "set", "map", "scalar"],
      rows: [[...cells.map((cell) => ({ __dbx_graph_cell: "nebula-v1", display: "before", nodes: [vertex], edges: [relationship], ...cell })), "unchanged scalar"]] as unknown as QueryResult["rows"],
      affected_rows: 0,
      execution_time_ms: 0,
    });
    applyGraphPropertyToResult(result, vertex, vertex.properties[0], { ...vertex.properties[0], value: "9007199254740994" });
    expect(result.rows[0].slice(0, 4).every((value) => String(value).includes("age: 9007199254740994"))).toBe(true);
    expect(result.rows[0][1]).toContain('"literal(n):9007199254740999"');
    expect(result.rows[0][3]).toContain("large: 9007199254740999");
    applyGraphPropertyToResult(result, relationship, relationship.properties[0], { ...relationship.properties[0], value: false });
    expect(result.rows[0].slice(0, 3).every((value) => String(value).includes("active: false"))).toBe(true);
    expect(result.rows[0][0]).toContain("[:WORK_IN@-2 {active: false}]");
    expect(result.rows[0][4]).toBe("unchanged scalar");
  });
  it("quotes identities and uses conditional updates for nodes and edges", () => {
    expect(buildNebulaGraphPropertyUpdate(node, node.properties[0], "9007199254740994")).toBe('UPDATE VERTEX ON `Person` "a\\"b" SET `age` = 9007199254740994 WHEN `age` == 9007199254740993 YIELD `age` AS dbx_value');
    expect(buildNebulaGraphPropertyUpdate(edge, edge.properties[0], false)).toBe('UPDATE EDGE ON `WORK_IN` "a\\"b" -> "company"@-2 SET `active` = false WHEN `active` == true YIELD `active` AS dbx_value');
    expect(buildNebulaGraphExpand(node)).toContain('GET SUBGRAPH WITH PROP 1 STEPS FROM "a\\"b"');
  });

  it("rejects malformed numeric edits and missing Tag identity", () => {
    expect(() => buildNebulaGraphPropertyUpdate(node, node.properties[0], "1; DELETE VERTEX")).toThrow();
    expect(() => buildNebulaGraphPropertyUpdate(node, { ...node.properties[0], owner: "Other" }, "1")).toThrow();
  });

  it("requires returned values and updates linked direct result cells", () => {
    const property = node.properties[0];
    const result: QueryResult = { columns: ["v"], rows: [["old"]], affected_rows: 0, execution_time_ms: 0, graph_data: { nodes: [node], edges: [], cells: [{ row: 0, column: 0, kind: "vertex", nodeIds: ["n"], edgeIds: [] }] } };
    const response: QueryResult = { columns: ["dbx_value"], rows: [["9007199254740994"]], affected_rows: 0, execution_time_ms: 0 };
    const updated: GraphProperty = graphPropertyFromUpdateResult(response, property);
    applyGraphPropertyToResult(result, node, property, updated);
    expect(node.properties[0].value).toBe("9007199254740994");
    expect(result.rows[0][0]).toContain("9007199254740994");
    expect(() => graphPropertyFromUpdateResult({ ...response, rows: [] }, property)).toThrow();
  });

  it.each([
    ["int", "21", "22", false],
    ["int", "9007199254740993", "9007199254740992", false],
    ["int", "9007199254740993", "9007199254740993", true],
    ["int", "0", "-0", true],
    ["float", "100", "1e2", true],
    ["float", "1e-06", "0.000001", true],
    ["float", "-1e-06", "-0.000001", true],
    ["float", "1e+20", "100000000000000000000", true],
    ["float", "21.5", "22.5", false],
    // A stored single-precision FLOAT echoes back through a float64 format;
    // the promoted representation must still match the requested value.
    ["float", "3.1500000948905659", "3.15", true],
    ["float", "0.10000000149011612", "0.1", true],
    ["float", "3.1500000948905659", "3.16", false],
    ["float", "", "0", false],
    ["float", "NaN", "NaN", false],
    ["bool", true, false, false],
    ["bool", false, false, true],
    ["string", "old", "new", false],
    ["string", "new", "new", true],
  ] as const)("checks the stored %s value %s against requested %s", (type, stored, requested, expected) => {
    expect(graphPropertyMatchesValue({ owner: "Person", name: "value", type, value: stored }, requested)).toBe(expected);
  });

  it("does not accept malformed booleans or inexact integers as saved values", () => {
    const response: QueryResult = { columns: ["dbx_value"], rows: [["unexpected"]], affected_rows: 0, execution_time_ms: 0 };
    expect(() => graphPropertyFromUpdateResult(response, edge.properties[0])).toThrow("boolean");
    expect(() => graphPropertyFromUpdateResult({ ...response, rows: [[9007199254740992]] }, node.properties[0])).toThrow("integer");
  });
});
