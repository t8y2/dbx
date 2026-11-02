import { describe, expect, it } from "vitest";
import { appendQueryResultSegment } from "@/stores/queryStore";
import { extractGraphCells, type GraphNode } from "@/lib/graph/graphResult";
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
    expect(appendQueryResultSegment(first, page("ignored"), 1).graph_data?.cells).toHaveLength(1);
  });
});
