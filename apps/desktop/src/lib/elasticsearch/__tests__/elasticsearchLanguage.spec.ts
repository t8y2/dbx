import { StandardSQL } from "@codemirror/lang-sql";
import { ensureSyntaxTree, foldable, matchBrackets, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { createSqlBlockFoldService } from "@/lib/editor/codemirrorSqlBlockFolding";
import { elasticsearchJsonDiagnostics, elasticsearchLanguage } from "@/lib/elasticsearch/elasticsearchLanguage";

const doc = `POST /orders/_search
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "status": "paid" } }
      ],
      "must": [
        { "match": { "title": "GET /not-a-request { }" } }
      ]
    }
  }
}

GET /orders/_count
{
  "query": {
    "match_all": {}
  }
}`;

function stateFor(text: string, databaseType: "elasticsearch" | "easysearch" = "elasticsearch") {
  const state = EditorState.create({ doc: text, extensions: [elasticsearchLanguage(StandardSQL.language.parser), createSqlBlockFoldService(databaseType)] });
  ensureSyntaxTree(state, text.length, 5_000);
  return state;
}

function foldedText(state: EditorState, lineNumber: number) {
  const line = state.doc.line(lineNumber);
  const range = foldable(state, line.from, line.to);
  return range ? state.sliceDoc(range.from, range.to) : null;
}

describe("Elasticsearch REST JSON language", () => {
  it.each(["elasticsearch", "easysearch"] as const)("folds nested objects and arrays while retaining %s request folds", (databaseType) => {
    const state = stateFor(doc, databaseType);
    expect(foldedText(state, 1)).toBe(doc.slice(doc.indexOf("\n"), doc.indexOf("\n\n")));
    expect(foldedText(state, 3)).toContain('"bool"');
    expect(foldedText(state, 4)).toContain('"filter"');
    expect(foldedText(state, 5)).toBe('\n        { "term": { "status": "paid" } }\n      ');
    expect(foldedText(state, 8)).toContain('"match"');
    expect(foldedText(state, 15)).toContain('"match_all"');
    expect(foldedText(state, 17)).toContain('"match_all"');
    expect(elasticsearchJsonDiagnostics(state)).toEqual([]);
  });

  it("parses JSON property names and matches nested braces without treating string content as structure", () => {
    const state = stateFor(doc);
    const property = doc.indexOf('"filter"');
    expect(syntaxTree(state).resolveInner(property + 1).name).toBe("PropertyName");
    const opener = doc.indexOf("[", property);
    const closer = doc.indexOf("]", opener);
    expect(matchBrackets(state, opener, 1)).toMatchObject({ matched: true, start: { from: opener, to: opener + 1 }, end: { from: closer, to: closer + 1 } });
    const inString = doc.indexOf("GET /not-a-request");
    expect(syntaxTree(state).resolveInner(inString + 2).name).toBe("String");
  });

  it("ignores comment preambles and bodyless headers", () => {
    const state = stateFor('# first\nGET /_cluster/health\n\n// next\n/* a comment */\nPOST /orders/_search\n{ "query": { "match_all": {} } }\n');
    expect(syntaxTree(state).resolveInner(2).name).toBe("RestComment");
    expect(elasticsearchJsonDiagnostics(state)).toEqual([]);
    const properties: string[] = [];
    syntaxTree(state).iterate({
      enter(node) {
        if (node.name === "PropertyName") properties.push(state.sliceDoc(node.from, node.to));
      },
    });
    expect(properties).toEqual(['"query"', '"match_all"']);
  });

  it("reports malformed JSON in the correct request and clears the error after an edit", () => {
    const text = 'GET /_cluster/health\n\nPOST /orders/_search\n{ "query": { "match_all": {} }, }';
    const state = stateFor(text);
    const diagnostics = elasticsearchJsonDiagnostics(state);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe("error");
    expect(diagnostics[0].from).toBeGreaterThan(text.indexOf("POST"));
    const comma = text.lastIndexOf(",");
    const updated = state.update({ changes: { from: comma, to: comma + 1, insert: "" } }).state;
    ensureSyntaxTree(updated, updated.doc.length, 5_000);
    expect(elasticsearchJsonDiagnostics(updated)).toEqual([]);
    expect(syntaxTree(updated).resolveInner(text.indexOf('"query"') + 1).name).toBe("PropertyName");
  });

  it("keeps incomplete JSON diagnostics within the body", () => {
    const text = 'POST /orders/_search\n{ "query": {';
    const diagnostics = elasticsearchJsonDiagnostics(stateFor(text));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].from).toBeGreaterThan(text.indexOf("\n"));
    expect(diagnostics[0].to).toBeLessThanOrEqual(text.length);
  });

  it.each(["/_bulk", "/orders/_bulk?refresh=true", "/_msearch", "/_msearch/template"])("accepts separate NDJSON values for %s", (path) => {
    const text = `POST ${path}\n{"index": {"_id": "1"}}\n{"title": "sample"}\n`;
    const state = stateFor(text);
    expect(elasticsearchJsonDiagnostics(state)).toEqual([]);
    expect(syntaxTree(state).resolveInner(text.indexOf('"title"') + 1).name).toBe("PropertyName");
  });

  it("retains SQL parsing outside REST documents", () => {
    const text = "SELECT name FROM orders WHERE total > 10";
    const state = stateFor(text);
    expect(syntaxTree(state).resolveInner(2).name).toBe("Keyword");
    expect(elasticsearchJsonDiagnostics(state)).toEqual([]);
  });

  it("keeps body offsets correct after inserting a request and supports tab-separated headers", () => {
    const state = stateFor(doc);
    const prefix = "GET\t/_cluster/health\n\n";
    const updated = state.update({ changes: { from: 0, insert: prefix } }).state;
    ensureSyntaxTree(updated, updated.doc.length, 5000);
    expect(syntaxTree(updated).resolveInner(1).name).toBe("RequestMethod");
    expect(syntaxTree(updated).resolveInner(prefix.length + doc.indexOf('"filter"') + 1).name).toBe("PropertyName");
    expect(elasticsearchJsonDiagnostics(updated)).toEqual([]);
    expect(foldedText(updated, 7)).toContain('"term"');
  });

  it("supports a partial parse before completing the remaining request bodies", () => {
    const parser = elasticsearchLanguage(StandardSQL.language.parser).language.parser;
    const partial = parser.startParse(doc);
    const end = doc.indexOf("GET /orders/_count");
    partial.stopAt(end);
    let tree = partial.advance();
    while (!tree) tree = partial.advance();
    expect(tree.length).toBe(end);
    expect(tree.resolveInner(doc.indexOf('"filter"') + 1).name).toBe("PropertyName");
    const state = stateFor(doc);
    expect(syntaxTree(state).resolveInner(doc.lastIndexOf('"query"') + 1).name).toBe("PropertyName");
  });
});
