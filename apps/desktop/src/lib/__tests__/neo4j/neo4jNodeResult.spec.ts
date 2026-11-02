import { computed, effectScope, nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";
import { extractNeo4jNodeCells, projectNeo4jNodeResult, type Neo4jNodeProperty } from "@/lib/neo4j/neo4jNodeResult";
import { useNeo4jNodeTableResult } from "@/composables/useNeo4jNodeTableResult";
import { appendQueryResultSegment } from "@/stores/queryStore";
import { buildTabResultSnapshot, decodeTabResultSnapshot, encodeTabResultSnapshot } from "@/lib/tabs/tabResultCache";
import type { QueryResult, QueryTab } from "@/types/database";

function node(properties: Neo4jNodeProperty[], display = "(:QA)") {
  return { __dbx_neo4j_node: "v1", display, properties };
}

function property(name: string, value: string, type = "String"): Neo4jNodeProperty {
  return { name, type, value };
}

function result(columns: string[], rows: unknown[][]): QueryResult {
  const value = { columns, rows, affected_rows: 0, execution_time_ms: 1 } as QueryResult;
  extractNeo4jNodeCells(value);
  return value;
}

describe("Neo4j node table projection", () => {
  it("qualifies multiple node aliases, keeps scalars and exact integers, and fills absent properties with null", () => {
    const source = result(
      ["p", "c", "score"],
      [
        [node([property("name", "Ada"), property("age", "9007199254740993", "Integer")]), node([property("name", "QA Labs")]), "7"],
        [node([property("name", "Bob")]), null, "8"],
      ],
    );
    const projected = projectNeo4jNodeResult(source);
    expect(projected.columns).toEqual(["p", "c", "score", "p.name", "p.age", "c.name"]);
    expect(projected.rows).toEqual([
      ["(:QA)", "(:QA)", "7", "Ada", "9007199254740993", "QA Labs"],
      ["(:QA)", null, "8", "Bob", null, null],
    ]);
    expect(projected.hidden_column_indexes).toEqual([0, 1]);
    expect(projected.column_types?.[4]).toBe("Integer");
    expect(source.columns).toEqual(["p", "c", "score"]);
    expect(source.rows[0]).toEqual(["(:QA)", "(:QA)", "7"]);
    expect(projectNeo4jNodeResult(projected)).toBe(projected);
  });

  it("retains empty and mixed node/scalar source cells, including node-looking strings", () => {
    const literal = JSON.stringify(node([property("fake", "no")]));
    const source = result(["n"], [[node([property("value", "42", "Integer")])], [node([])], [literal], [null], [node([property("value", "text")])]]);
    const projected = projectNeo4jNodeResult(source);
    expect(projected.hidden_column_indexes).toEqual([]);
    expect(projected.rows[2]).toEqual([literal, null]);
    expect(projected.column_types?.[1]).toBe("Any");
    expect(projectNeo4jNodeResult(result(["n"], [[node([])]]))).toMatchObject({ columns: ["n"], rows: [["(:QA)"]] });
  });

  it("disambiguates existing aliases, dots and prototype-like property names without losing values", () => {
    const projected = projectNeo4jNodeResult(result(["n", "n.name", "n.name (2)"], [[node([property("name", "Ada"), property("__proto__", "safe"), property("a.b", "dot")]), "scalar", "another"]]));
    expect(projected.columns).toEqual(["n", "n.name", "n.name (2)", "n.name (3)", "n.__proto__", "n.a.b"]);
    expect(projected.rows[0]?.slice(3)).toEqual(["Ada", "safe", "dot"]);
  });

  it("does not normalize unknown versions, malformed envelopes or ordinary scalar results", () => {
    const envelopes = [{ ...node([]), __dbx_neo4j_node: "v2" }, node([{ ...property("bad", "x"), value: {} } as unknown as Neo4jNodeProperty]), node([property("a", "x"), property("a", "y")])];
    const source = result(
      ["n"],
      envelopes.map((value) => [value]),
    );
    expect(source.neo4j_node_cells).toBeUndefined();
    expect(source.rows).toEqual(envelopes.map((value) => [value]));
    const scalar = result(["name"], [["Ada"], [null]]);
    expect(projectNeo4jNodeResult(scalar)).toBe(scalar);
  });

  it("keeps generated ordinals stable across cursor pages and clips metadata at the row cap", () => {
    const first = result(["n"], [[null], [node([property("name", "Ada")])]]);
    const second = { columns: ["n"], rows: [[node([property("late", "yes")])], [node([property("discarded", "no")])]], affected_rows: 0, execution_time_ms: 1, has_more: true } as QueryResult;
    const merged = appendQueryResultSegment(first, second, 3);
    expect(merged.columns).toEqual(["n"]);
    expect(merged.neo4j_node_cells?.map((cell) => cell.row_index)).toEqual([1, 2]);
    const projected = projectNeo4jNodeResult(merged);
    expect(projected.columns).toEqual(["n", "n.name", "n.late"]);
    expect(projected.rows).toEqual([
      [null, null, null],
      ["(:QA)", "Ada", null],
      ["(:QA)", null, "yes"],
    ]);
    expect(merged.has_more).toBe(false);
    const emptyFirst = appendQueryResultSegment(result(["n"], [[null]]), result(["n"], [[node([property("new", "yes")])]]), 10);
    expect(projectNeo4jNodeResult(emptyFirst).rows).toEqual([
      [null, null],
      ["(:QA)", "yes"],
    ]);
  });

  it("retains typed properties through active and historical result cache restore without cursor ids", () => {
    const source = { ...result(["n"], [[node([property("age", "9007199254740993", "Integer")])]]), session_id: "private-cursor" };
    const tab = { result: source, results: [source], resultRuns: [{ id: "run", title: "Run", sequence: 1, sql: "RETURN n", createdAt: 1, result: source, results: [source] }] } as QueryTab;
    const snapshot = buildTabResultSnapshot(tab)!;
    expect(snapshot.result?.neo4j_node_cells).not.toBe(source.neo4j_node_cells);
    const restored = decodeTabResultSnapshot(encodeTabResultSnapshot(snapshot));
    for (const value of [restored.result, restored.results?.[0], restored.resultRuns?.[0].result, restored.resultRuns?.[0].results?.[0]]) {
      expect(value?.session_id).toBeUndefined();
      expect(projectNeo4jNodeResult(value!).rows).toEqual([["(:QA)", "9007199254740993"]]);
    }
  });

  it("sorts only presentation rows with exact integers and resets on result changes", async () => {
    const scope = effectScope();
    const source = ref(result(["n"], [[node([property("age", "9007199254740993", "Integer")])], [node([property("age", "9007199254740992", "Integer")])]]));
    source.value.large_value_cells = [{ row_index: 0, column_index: 0, original_bytes: 100 }];
    const key = ref("first");
    const table = scope.run(() =>
      useNeo4jNodeTableResult(
        computed(() => source.value),
        computed(() => key.value),
      ),
    )!;
    table.setSort("n.age", 1, "asc");
    expect(table.result.value?.rows.map((row) => row[1])).toEqual(["9007199254740992", "9007199254740993"]);
    expect(table.result.value?.large_value_cells?.[0].row_index).toBe(1);
    expect(source.value.neo4j_node_cells?.[0].properties[0].value).toBe("9007199254740993");
    table.setSort("n.age", 1, null);
    expect(table.result.value?.rows[0]?.[1]).toBe("9007199254740993");
    table.setSort("n.age", 1, "desc");
    key.value = "second";
    await nextTick();
    expect(table.sort.value).toBeUndefined();
    scope.stop();
  });
});
