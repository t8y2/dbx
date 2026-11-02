import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { buildGraphCompletionItems, getGraphCompletionContext, shouldAutoOpenGraphCompletion } from "./graphCompletion";
import { graphFunctionDefinitions } from "./graphQueryFunctions";
import { graphQueryLanguage, graphQueryTokens, type GraphQueryDatabase } from "./graphQueryLanguage";
import { graphQueryDatabases, graphQueryProfile, isGraphQueryDatabase } from "./graphQueryProfiles";
import { getGraphFunctionSignatureHelp } from "./graphSignatureHelp";

const tables = [
  { name: "Person", type: "table" as const },
  { name: "Odd label", type: "table" as const },
];
function context(source: string, type: GraphQueryDatabase) {
  return getGraphCompletionContext(source, source.length, type);
}
function items(source: string, type: GraphQueryDatabase) {
  return buildGraphCompletionItems(context(source, type), type, { tables, columns: [{ table: "Person", name: "name" }] });
}

describe.each(graphQueryDatabases)("%s graph completion conformance", (type) => {
  it("registers the native lexer without registering SQL databases", () => {
    expect(isGraphQueryDatabase(type)).toBe(true);
    for (const sqlType of ["mysql", "postgres", "oracle", "sqlserver", "jdbc", "salesforce", "mongodb", "redis"] as const) expect(isGraphQueryDatabase(sqlType)).toBe(false);
    const state = EditorState.create({ doc: "MATCH (n:Person) RETURN n", extensions: [graphQueryLanguage(type)] });
    expect(syntaxTree(state).resolveInner(2).name).toBe("keyword");
    expect(graphQueryTokens("MATCH (n:Person)", type).map((token) => token.text)).toEqual(["MATCH", "(", "n", ":", "Person", ")"]);
  });

  it("uses native keywords and catalog signatures rather than SQL suggestions", () => {
    expect(items("mat", type).map((item) => item.label)).toContain("MATCH");
    const names = items("", type).map((item) => item.label);
    for (const name of ["SELECT", "GROUP_CONCAT", "GROUP BY"]) expect(names).not.toContain(name);
    const functions = graphFunctionDefinitions(type);
    expect(new Set(functions.map((fn) => fn.name.toLowerCase())).size).toBe(functions.length);
    for (const fn of functions) {
      const source = "RETURN " + fn.name + "(";
      expect(getGraphFunctionSignatureHelp(source, source.length, type)?.parameters).toEqual(fn.parameters);
    }
  });

  it.each(["RETURN 'mat", 'RETURN "mat', "RETURN 'escaped\\' mat", "/* ignored\nmat"])("suppresses incomplete literals/comments: %s", (source) => {
    expect(items(source, type)).toEqual([]);
    expect(shouldAutoOpenGraphCompletion(source, source.length, type)).toBe(false);
  });

  it("resumes native completion after a line comment or a closed literal", () => {
    const marker = graphQueryProfile(type).lineComment;
    expect(items(marker + " ignored\nmat", type).map((item) => item.label)).toContain("MATCH");
    expect(items('RETURN "ignored"; mat', type).map((item) => item.label)).toContain("MATCH");
    expect(items(marker + " mat", type)).toEqual([]);
  });

  it("tracks aliases, WITH visibility, WITH *, path variables and UNWIND", () => {
    const alias = context("MATCH (n:Person) WITH n AS p RETURN p.", type);
    expect(alias.objects).toEqual(["Person"]);
    expect(alias.variables).toEqual(["p"]);
    const dropped = context("MATCH (n:Person) WITH 1 AS x RETURN n.", type);
    expect(dropped.objects).not.toContain("Person");
    expect(dropped.variables).toEqual(["x"]);
    expect(context("MATCH (n:Person) WITH * RETURN n.", type).objects).toEqual(["Person"]);
    expect(items("UNWIND [1,2] AS item RETURN it", type).map((item) => item.label)).toContain("item");
    expect(context("MATCH p=(n:Person)-->() RETURN p", type).variables).toContain("p");
  });

  it("does not infer pattern variables from function calls or previous statements", () => {
    expect(context("RETURN coalesce(value, other), va", type).variables).toEqual([]);
    expect(context('MATCH (old:Person) RETURN old; RETURN "(fake:Fake)", old.', type).variables).toEqual([]);
    expect(context("MATCH (n:Person) RETURN n UNION RETURN n.", type).variables).toEqual([]);
  });

  it("resolves labels, arrows and property-map keys", () => {
    expect(context("MATCH (n:", type).mode).toBe("label");
    expect(context("MATCH ()-[r:", type).mode).toBe("relationship");
    expect(context("MATCH (n:Person)-->(m:Person) RETURN m.", type).objects).toEqual(["Person"]);
    expect(items("MATCH (n:Person {na", type).map((item) => item.label)).toEqual(["name"]);
    expect(items("MATCH (n:Person {age: 1, na", type).map((item) => item.label)).toEqual(["name"]);
  });

  it("quotes reserved/escaped metadata and replaces identifier suffixes", () => {
    const source = "MATCH (n:`Per-old`)";
    const ctx = getGraphCompletionContext(source, source.indexOf("Per") + 3, type);
    expect(ctx).toMatchObject({ quoted: true, replaceClosingQuote: "`" });
    expect(buildGraphCompletionItems(ctx, type, { tables })[0]?.apply).toBe("Person`");
    expect(items("MATCH (n:Odd", type)[0]?.apply).toBe("`Odd label`");
    const field = type === "nebula" ? "MATCH (n:Person) RETURN n.Person.re" : "MATCH (n:Person) RETURN n.re";
    expect(buildGraphCompletionItems(context(field, type), type, { columns: [{ name: "RETURN", table: "Person" }] })[0]?.apply).toBe("`RETURN`");
  });

  it("honors case/parameter settings without changing identifier case", () => {
    const result = buildGraphCompletionItems(context("MATCH (Camel:Person) RETURN ", type), type, {}, { keywordCase: "lower", functionCase: "upper", functionCompletionIncludeParams: false });
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ label: "return" }), expect.objectContaining({ label: "REPLACE", apply: "REPLACE(${})" }), expect.objectContaining({ label: "Camel", apply: "Camel" })]));
    expect(items("RETURN rep", type).find((item) => item.label === "replace")?.apply).toBe("replace(${string}, ${search}, ${replacement})");
    const source = "RETURN rep_old ('a', 'b', 'c')";
    const ctx = getGraphCompletionContext(source, "RETURN rep".length, type);
    expect(ctx.openingParenAfterCursor).toBe(true);
    expect(buildGraphCompletionItems(ctx, type).find((item) => item.label === "replace")?.apply).toBe("replace");
  });

  it("keeps user snippets unchanged and excludes SQL built-ins", () => {
    const result = buildGraphCompletionItems(
      context("gq", type),
      type,
      {},
      {
        snippets: [
          { id: "custom", prefix: "gq", label: "Find Person", body: "MATCH (Camel:Person) RETURN Camel" },
          { id: "builtin-select", prefix: "gq", label: "Select", body: "SELECT * FROM table" },
          { id: "disabled", prefix: "gq", label: "Disabled", body: "RETURN 1", enabled: false },
        ],
      },
    );
    expect(result).toEqual([expect.objectContaining({ label: "Find Person", filterText: "gq", apply: "MATCH (Camel:Person) RETURN Camel", exactMatch: true })]);
  });

  it("tracks nested argument groups and temporal overloads", () => {
    for (const [source, name, activeParameter] of [
      ["RETURN replace(substring(n.name, 1), ", "replace", 1],
      ["RETURN substring(n.name, 0, ", "substring", 2],
      ["RETURN coalesce({a: 1, b: [1,2]}, ", "coalesce", 1],
      ["RETURN reduce(acc = 0, ", "reduce", 1],
    ] as const) {
      expect(getGraphFunctionSignatureHelp(source, source.length, type)).toMatchObject({ name, activeParameter });
    }
    const source = "RETURN datetime({year: 2026, ";
    expect(getGraphFunctionSignatureHelp(source, source.length, type)).toMatchObject({ activeOverload: 1, parameters: ["value"] });
  });

  it.each(["RETURN 'replace(", "RETURN replace('open", "/* replace(", "RETURN `replace(`", "RETURN n.replace(", "RETURN apoc.replace(", "RETURN GROUP_CONCAT(", "RETURN replace('a','b','c'); RETURN 1", "RETURN replace('a','b','c')"])("suppresses false signatures: %s", (source) => {
    expect(getGraphFunctionSignatureHelp(source, source.length, type)).toBeNull();
  });

  it("rejects a function whose name is cut by the analysis window", () => {
    expect(getGraphFunctionSignatureHelp("replace(", 8, type, { truncatedPrefix: true })).toBeNull();
  });
  it("does not offer ordinary functions as CALL procedures", () => {
    expect(items("CALL db.na", type).filter((item) => item.type === "function")).toEqual([]);
    const source = "CALL db.nameFromElementId(";
    expect(getGraphFunctionSignatureHelp(source, source.length, type)).toBeNull();
  });
});
