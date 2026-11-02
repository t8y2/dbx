import { describe, expect, it } from "vitest";
import { classifySqlRisk, classifySqlStatementRisk } from "@/lib/sql/sqlRisk";
import { sqlLooksLikeMutation } from "@/lib/database/readOnlyWriteAccess";

const SEARCH_REQUEST = 'POST /demo/_search\n{\n  "from": 0,\n  "size": 100,\n  "sort": [\n    "_doc"\n  ]\n}';

describe("Elasticsearch request risk", () => {
  it("treats searches and other retrieval requests as reads", () => {
    for (const dialect of ["elasticsearch", "easysearch"] as const) {
      expect(classifySqlRisk(SEARCH_REQUEST, { dialect }).risk).toBe("read");
      expect(classifySqlRisk("GET /demo/_doc/1", { dialect }).risk).toBe("read");
      expect(classifySqlRisk("GET /_cat/indices?format=json", { dialect }).risk).toBe("read");
      expect(classifySqlRisk("HEAD /demo", { dialect }).risk).toBe("read");
      expect(classifySqlRisk('POST /demo/_count\n{"query":{"match_all":{}}}', { dialect }).risk).toBe("read");
      expect(classifySqlRisk('POST /_sql\n{"query":"SELECT * FROM demo"}', { dialect }).risk).toBe("read");
    }
  });

  it("treats document changes as writes and index changes as DDL", () => {
    expect(classifySqlRisk('POST /demo/_doc\n{"a":1}', { dialect: "elasticsearch" }).risk).toBe("write");
    expect(classifySqlRisk('PUT /demo/_doc/1\n{"a":1}', { dialect: "elasticsearch" }).risk).toBe("write");
    expect(classifySqlRisk("DELETE /demo/_doc/1", { dialect: "elasticsearch" }).risk).toBe("write");
    expect(classifySqlRisk("DELETE /demo", { dialect: "elasticsearch" }).risk).toBe("ddl");
    expect(classifySqlRisk('PUT /demo\n{"settings":{}}', { dialect: "elasticsearch" }).risk).toBe("ddl");
    expect(classifySqlRisk('POST /demo/_delete_by_query\n{"query":{"match_all":{}}}', { dialect: "elasticsearch" }).risk).toBe("ddl");
  });

  it("reports the highest risk across every request in the editor text", () => {
    const source = `${SEARCH_REQUEST}\n\nDELETE /demo`;
    expect(classifySqlRisk(source, { dialect: "elasticsearch" }).risk).toBe("ddl");
    expect(classifySqlStatementRisk(SEARCH_REQUEST, { dialect: "elasticsearch" }).risk).toBe("read");
  });

  it("reads the request line through query strings, trailing slashes and CRLF endings", () => {
    expect(classifySqlRisk("GET /demo/_search?size=1", { dialect: "elasticsearch" }).risk).toBe("read");
    expect(classifySqlRisk("post /demo/_search/\r\n{}", { dialect: "elasticsearch" }).risk).toBe("read");
    expect(classifySqlRisk("DELETE /demo/_doc/1?refresh=true", { dialect: "elasticsearch" }).risk).toBe("write");
    expect(classifySqlRisk("  GET /demo/_search  // inline comment", { dialect: "elasticsearch" }).risk).toBe("read");
  });

  it("ignores commented-out requests", () => {
    expect(classifySqlRisk(`# DELETE /demo\n// DELETE /demo\n/* DELETE /demo */\n${SEARCH_REQUEST}`, { dialect: "elasticsearch" }).risk).toBe("read");
    expect(classifySqlRisk("/*\nDELETE /demo\n*/\nGET /demo/_search", { dialect: "elasticsearch" }).risk).toBe("read");
  });

  it("still classifies Elasticsearch SQL through the SQL rules", () => {
    expect(classifySqlRisk("SELECT * FROM demo", { dialect: "elasticsearch" }).risk).toBe("read");
    expect(classifySqlRisk("DROP TABLE demo", { dialect: "elasticsearch" }).risk).toBe("ddl");
  });

  it("leaves text that does not start with a request line to the SQL rules", () => {
    // The backend anchors on the first line too, so a stray request line further
    // down must not turn unparseable text into a read.
    expect(classifySqlRisk('{"query":{"match_all":{}}}\nGET /demo/_search', { dialect: "elasticsearch" }).risk).toBe("unknown");
  });

  it("keeps REST requests classified as SQL for other database types", () => {
    expect(classifySqlRisk(SEARCH_REQUEST, { dialect: "mysql" }).risk).toBe("unknown");
  });

  it("does not ask a read-only connection to unlock writes for a search", () => {
    expect(sqlLooksLikeMutation(SEARCH_REQUEST, "elasticsearch")).toBe(false);
    expect(sqlLooksLikeMutation("GET /demo/_search", "easysearch")).toBe(false);
    expect(sqlLooksLikeMutation("DELETE /demo", "elasticsearch")).toBe(true);
    expect(sqlLooksLikeMutation('POST /demo/_doc\n{"a":1}', "elasticsearch")).toBe(true);
  });
});
