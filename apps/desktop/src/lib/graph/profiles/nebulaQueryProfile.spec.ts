import { describe, expect, it } from "vitest";
import { buildGraphCompletionItems, getGraphCompletionContext } from "../graphCompletion";
import { getGraphFunctionSignatureHelp } from "../graphSignatureHelp";
import profile from "./nebulaQueryProfile";

const tables = [
  { name: "player", type: "table" as const },
  { name: "follow", type: "view" as const },
  { name: "serve", type: "view" as const },
  { name: "TAG", type: "table" as const },
];
function items(source: string) {
  return buildGraphCompletionItems(getGraphCompletionContext(source, source.length, "nebula"), "nebula", { tables, databases: ["basketball"] });
}

describe("NebulaGraph nGQL completion profile", () => {
  it("covers native function families, including reduce, without Cypher-only functions", () => {
    const names = profile.functions.map((fn) => fn.name);
    for (const name of ["concat", "concat_ws", "substr", "std", "reduce", "all", "any", "isEmpty", "src", "dst", "rank", "now", "st_distance"]) expect(names).toContain(name);
    for (const name of ["vertex", "edge", "elementId", "point.distance", "uuid"]) expect(names).not.toContain(name);
    for (const word of ["ALTER", "DROP", "REBUILD", "INDEX", "GROUP", "KILL", "SUBMIT", "JOB"]) expect(profile.keywords).toContain(word);
  });

  it("keeps tags, edges, comma-separated traversals and spaces separate", () => {
    expect(items("MATCH (n:").map((item) => item.label)).toEqual(["player", "TAG"]);
    expect(items('GO FROM "1" OVER ').map((item) => item.label)).toEqual(["follow", "serve"]);
    expect(items('GO FROM "1" OVER follow, se').map((item) => item.label)).toEqual(["serve"]);
    expect(items("USE ba").map((item) => item.label)).toEqual(["basketball"]);
    expect(items("MATCH (n:TA")[0]?.apply).toBe("`TAG`");
  });

  it("resolves tag-qualified fields and pipe outputs", () => {
    const source = "MATCH (n:player)-[r:follow]->() RETURN n.player.na";
    expect(getGraphCompletionContext(source, source.length, "nebula")).toMatchObject({ mode: "property", objects: ["player"] });
    const edge = "MATCH ()-[r:follow]->() RETURN r.";
    expect(getGraphCompletionContext(edge, edge.length, "nebula")).toMatchObject({ mode: "property", objects: ["follow"] });
    expect(items('GO FROM "1" OVER follow YIELD dst(edge) AS next | YIELD $-.ne').map((item) => item.label)).toEqual(["next"]);
  });

  it("offers native multi-parameter and reduce templates", () => {
    expect(items("RETURN concat_w")[0]?.apply).toBe("concat_ws(${separator}, ${string1}, ${string2})");
    expect(items("RETURN red")[0]?.apply).toBe("reduce(${accumulator} = ${initial}, ${variable} IN ${list} | ${expression})");
    const source = "RETURN reduce(acc = 0, ";
    expect(getGraphFunctionSignatureHelp(source, source.length, "nebula")).toMatchObject({ name: "reduce", activeParameter: 1 });
  });
});
