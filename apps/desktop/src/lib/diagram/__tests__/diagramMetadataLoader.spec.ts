import { describe, expect, it, vi } from "vitest";
import { diagramIdentityKey, loadFocusedDiagram, type DiagramMetadataAdapter, type FocusedDiagramLoadRequest } from "../diagramMetadataLoader";
import type { ForeignKeyInfo } from "@/types/database";

const request = (names = ["A"]): FocusedDiagramLoadRequest => ({ connectionId: "c", database: "db", roots: names.map((name) => ({ schema: "public", name })) });
const fk = (name: string, schema?: string): ForeignKeyInfo => ({ name: "fk", column: "id", ref_table: name, ref_schema: schema, ref_column: "id", on_update: "NO ACTION", on_delete: "NO ACTION" });
function adapter(graph: Record<string, ForeignKeyInfo[]> = {}): DiagramMetadataAdapter {
  return { getColumns: vi.fn(async () => []), listIndexes: vi.fn(async () => []), listForeignKeys: vi.fn(async (table) => graph[`${table.schema}.${table.name}`] ?? []), getTableComment: vi.fn(async () => "comment") };
}

describe("focused outbound metadata traversal", () => {
  it.each([
    ["leaf", {}, ["A"]],
    ["chain", { "public.A": [fk("B")], "public.B": [fk("C")] }, ["A", "B", "C"]],
    ["branch", { "public.A": [fk("C"), fk("B")] }, ["A", "B", "C"]],
    ["cycle", { "public.A": [fk("B")], "public.B": [fk("A")] }, ["A", "B"]],
    ["self reference", { "public.A": [fk("A")] }, ["A"]],
    ["composite rows", { "public.A": [fk("B"), fk("B")] }, ["A", "B"]],
  ] as const)("loads %s once without requesting unrelated tables", async (_name, graph, expected) => {
    const metadata = adapter(graph);
    const result = await loadFocusedDiagram(request(), metadata);
    expect(result.tables.map((table) => table.name)).toEqual(expected);
    for (const method of [metadata.getColumns, metadata.listForeignKeys, metadata.listIndexes, metadata.getTableComment]) expect(method).toHaveBeenCalledTimes(expected.length);
    expect(result.rootKeys).toEqual([diagramIdentityKey({ schema: "public", name: "A" })]);
  });

  it("unions roots, deduplicates them, and preserves cross-schema and case identities", async () => {
    const metadata = adapter({ "public.A": [fk("B"), fk("A", "other")], "public.B": [fk("A"), fk("a")] });
    const result = await loadFocusedDiagram(request(["B", "A", "A"]), metadata);
    expect(result.tables.map((table) => [table.schema, table.name])).toEqual([
      ["other", "A"],
      ["public", "A"],
      ["public", "B"],
      ["public", "a"],
    ]);
    expect(metadata.getColumns).toHaveBeenCalledTimes(4);
  });

  it.each(["getColumns", "listForeignKeys", "listIndexes"] as const)("rejects required %s failures", async (method) => {
    const metadata = adapter();
    metadata[method] = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(loadFocusedDiagram(request(), metadata)).rejects.toThrow("offline");
  });

  it("allows optional comment failures", async () => {
    const metadata = adapter();
    metadata.getTableComment = vi.fn().mockRejectedValue(new Error("unsupported"));
    expect((await loadFocusedDiagram(request(), metadata)).tables[0].comment).toBeNull();
  });

  it("bounds table concurrency and reports a growing discovered count", async () => {
    const metadata = adapter({ "public.A": [fk("B"), fk("C"), fk("D"), fk("E")], "public.B": [fk("F")] });
    let running = 0;
    let peak = 0;
    metadata.getColumns = vi.fn(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return [];
    });
    const onProgress = vi.fn();
    await loadFocusedDiagram({ ...request(), concurrency: 2, onProgress }, metadata);
    expect(peak).toBe(2);
    expect(onProgress.mock.calls).toEqual([
      [0, 1],
      [1, 5],
      [3, 6],
      [5, 6],
      [6, 6],
    ]);
  });
});
