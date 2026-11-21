import { describe, expect, it } from "vitest";
import { buildGraphCompletionItems, getGraphCompletionContext } from "../graphCompletion";
import { getGraphFunctionSignatureHelp } from "../graphSignatureHelp";
import profile from "./neo4jQueryProfile";

describe("Neo4j Cypher completion profile", () => {
  it("covers the common Neo4j 5 function families without nGQL-only functions", () => {
    const names = profile.functions.map((fn) => fn.name);
    for (const name of ["rand", "randomUUID", "percentileCont", "stDev", "isEmpty", "point", "point.distance", "duration.between", "toStringOrNull", "elementId"]) expect(names).toContain(name);
    for (const name of ["src", "dst", "rank", "now", "uuid"]) expect(names).not.toContain(name);
    for (const word of ["DROP", "ALTER", "INDEXES", "FUNCTIONS", "PROCEDURES", "TRANSACTIONS"]) expect(profile.keywords).toContain(word);
  });

  it("completes qualified functions with leaf-only replacement and signature help", () => {
    const source = "RETURN point.di";
    const items = buildGraphCompletionItems(getGraphCompletionContext(source, source.length, "neo4j"), "neo4j");
    expect(items).toEqual([expect.objectContaining({ label: "distance", apply: "distance(${from}, ${to})" })]);
    const call = "RETURN duration.between(a, ";
    expect(getGraphFunctionSignatureHelp(call, call.length, "neo4j")).toMatchObject({ name: "duration.between", activeParameter: 1 });
  });

  it("prefers bound variables over function namespaces", () => {
    const source = "MATCH (point:Person) RETURN point.na";
    expect(getGraphCompletionContext(source, source.length, "neo4j")).toMatchObject({ mode: "property", objects: ["Person"] });
  });

  it("does not misrepresent node labels as relationship types", () => {
    const source = "MATCH ()-[r:";
    expect(buildGraphCompletionItems(getGraphCompletionContext(source, source.length, "neo4j"), "neo4j", { tables: [{ name: "Person", type: "table" }] })).toEqual([]);
  });
});
