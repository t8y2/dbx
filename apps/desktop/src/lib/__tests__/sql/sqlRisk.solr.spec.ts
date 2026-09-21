import { describe, expect, it } from "vitest";
import { classifySqlRisk, classifySqlStatementRisk } from "@/lib/sql/sqlRisk";
import { sqlLooksLikeMutation } from "@/lib/database/readOnlyWriteAccess";

const SEARCH_REQUEST = 'POST /solr/mycore/select\n{\n  "query": "*:*",\n  "limit": 100\n}';

describe("Solr request risk", () => {
  it("treats queries and other retrieval requests as reads", () => {
    expect(classifySqlRisk(SEARCH_REQUEST, { dialect: "solr" }).risk).toBe("read");
    expect(classifySqlRisk("GET /solr/mycore/select?q=*:*", { dialect: "solr" }).risk).toBe("read");
    expect(classifySqlRisk("GET /solr/admin/cores?action=STATUS", { dialect: "solr" }).risk).toBe("read");
    expect(classifySqlRisk("HEAD /solr/mycore/admin/ping", { dialect: "solr" }).risk).toBe("read");
    expect(classifySqlRisk('POST /solr/mycore/query\n{"query":"*:*"}', { dialect: "solr" }).risk).toBe("read");
    expect(classifySqlRisk('POST /mycore/suggest\n{"suggest":{"q":"sol"}}', { dialect: "solr" }).risk).toBe("read");
  });

  it("treats document updates as writes and admin/schema changes as dangerous", () => {
    expect(classifySqlRisk('POST /solr/mycore/update\n{"add":{"doc":{"id":"1"}}}', { dialect: "solr" }).risk).toBe("write");
    expect(classifySqlRisk('POST /mycore/update/json/docs\n{"a":1}', { dialect: "solr" }).risk).toBe("write");
    expect(classifySqlRisk('POST /solr/mycore/update?commit=true\n{"delete":{"query":"*:*"}}', { dialect: "solr" }).risk).toBe("write");
    expect(classifySqlRisk("POST /solr/admin/cores?action=CREATE&name=x", { dialect: "solr" }).risk).toBe("ddl");
    expect(classifySqlRisk('POST /solr/mycore/schema\n{"add-field":{"name":"f","type":"string"}}', { dialect: "solr" }).risk).toBe("ddl");
    expect(classifySqlRisk("DELETE /solr/mycore/update", { dialect: "solr" }).risk).toBe("write");
    expect(classifySqlRisk("DELETE /solr/mycore/config", { dialect: "solr" }).risk).toBe("ddl");
  });

  it("treats GET-driven update and admin actions as mutations", () => {
    // Solr update handlers answer GET (commit/optimize/stream.body) and
    // CoreAdmin actions ride on GET as well, so the method alone cannot mark
    // these paths read-only.
    expect(classifySqlRisk("GET /solr/mycore/update?commit=true", { dialect: "solr" }).risk).toBe("write");
    expect(classifySqlRisk("GET /solr/admin/cores?action=CREATE&name=x", { dialect: "solr" }).risk).toBe("ddl");
    expect(classifySqlRisk("GET /solr/admin/cores?action=UNLOAD&core=mycore", { dialect: "solr" }).risk).toBe("ddl");
    expect(classifySqlRisk("GET /solr/admin/cores?action=REQUESTSTATUS&requestid=1", { dialect: "solr" }).risk).toBe("read");
    expect(classifySqlRisk("GET /solr/admin/info/system", { dialect: "solr" }).risk).toBe("read");
  });

  it("treats GET replication commands outside the read whitelist as dangerous", () => {
    expect(classifySqlRisk("GET /solr/mycore/replication?command=details", { dialect: "solr" }).risk).toBe("read");
    expect(classifySqlRisk("GET /solr/mycore/replication?command=restorestatus", { dialect: "solr" }).risk).toBe("read");
    expect(classifySqlRisk("GET /solr/mycore/replication?command=filelist", { dialect: "solr" }).risk).toBe("read");
    expect(classifySqlRisk("GET /solr/mycore/replication", { dialect: "solr" }).risk).toBe("read");
    expect(classifySqlRisk("GET /solr/mycore/replication?command=disablereplication", { dialect: "solr" }).risk).toBe("ddl");
    expect(classifySqlRisk("GET /solr/mycore/replication?command=enablereplication", { dialect: "solr" }).risk).toBe("ddl");
    expect(classifySqlRisk("GET /solr/mycore/replication?command=fetchindex", { dialect: "solr" }).risk).toBe("ddl");
  });

  it("reports the highest risk across every request in the editor text", () => {
    const source = `${SEARCH_REQUEST}\n\nPOST /solr/admin/cores?action=UNLOAD&core=mycore`;
    expect(classifySqlRisk(source, { dialect: "solr" }).risk).toBe("ddl");
    expect(classifySqlStatementRisk(SEARCH_REQUEST, { dialect: "solr" }).risk).toBe("read");
  });

  it("reads the request line through query strings, trailing slashes and CRLF endings", () => {
    expect(classifySqlRisk("GET /solr/mycore/select?q=*:*&rows=1", { dialect: "solr" }).risk).toBe("read");
    expect(classifySqlRisk("post /solr/mycore/select/\r\n{}", { dialect: "solr" }).risk).toBe("read");
    expect(classifySqlRisk('POST /solr/mycore/update?commitWithin=500\n{"delete":{"id":"1"}}', { dialect: "solr" }).risk).toBe("write");
    expect(classifySqlRisk("  GET /solr/mycore/select  // inline comment", { dialect: "solr" }).risk).toBe("read");
  });

  it("ignores commented-out requests", () => {
    expect(classifySqlRisk(`# DELETE /solr/mycore/config\n// DELETE /solr/mycore/config\n/* DELETE /solr/mycore/config */\n${SEARCH_REQUEST}`, { dialect: "solr" }).risk).toBe("read");
    expect(classifySqlRisk("/*\nDELETE /solr/mycore/config\n*/\nGET /solr/mycore/select", { dialect: "solr" }).risk).toBe("read");
  });

  it("leaves text that does not start with a request line to the SQL rules", () => {
    // The backend anchors on the first line too, so a stray request line further
    // down must not turn unparseable text into a read.
    expect(classifySqlRisk('{"query":"*:*"}\nGET /solr/mycore/select', { dialect: "solr" }).risk).toBe("unknown");
  });

  it("keeps REST requests classified as SQL for other database types", () => {
    expect(classifySqlRisk(SEARCH_REQUEST, { dialect: "mysql" }).risk).toBe("unknown");
    expect(classifySqlRisk(SEARCH_REQUEST, { dialect: "elasticsearch" }).risk).not.toBe("read");
  });

  it("does not ask a read-only connection to unlock writes for a search", () => {
    expect(sqlLooksLikeMutation(SEARCH_REQUEST, "solr")).toBe(false);
    expect(sqlLooksLikeMutation("GET /solr/mycore/select?q=*:*", "solr")).toBe(false);
    expect(sqlLooksLikeMutation('POST /solr/mycore/update\n{"delete":{"query":"*:*"}}', "solr")).toBe(true);
    expect(sqlLooksLikeMutation("POST /solr/admin/cores?action=CREATE&name=x", "solr")).toBe(true);
  });
});
