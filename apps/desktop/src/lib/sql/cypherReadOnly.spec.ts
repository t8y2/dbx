import { describe, expect, it } from "vitest";
import { classifySqlRisk } from "./sqlRisk";

describe("Neo4j read-only query safety", () => {
  it.each(["SHOW DATABASES", "EXPLAIN MATCH (n) RETURN n"])("preserves read-only metadata and plans: %s", (sql) => expect(classifySqlRisk(sql, { dialect: "neo4j" }).risk).toBe("read"));
  it.each(["MATCH (n)-->(m) RETURN n,m", "MATCH (n) WHERE elementId(n) = '4:id:1' OPTIONAL MATCH (n)-[r]-(m) RETURN n,r,m LIMIT 200", "// SET is a comment\nMATCH (n:`DELETE`) WHERE n.name = 'CREATE; SET' RETURN n", "UNWIND [1,2] AS x RETURN x; RETURN 1", "/* comment */ WITH 1 AS x RETURN x"])(
    "allows pure Cypher reads: %s",
    (sql) => expect(classifySqlRisk(sql, { dialect: "neo4j" }).risk).toBe("read"),
  );

  it.each([
    "MATCH (n)-->(m) SET n.x = 1 RETURN n",
    "MATCH (n) RETURN n /* outer /* inner */ UNION MATCH (m) SET m.x=1 RETURN m /* */",
    "MATCH (n) RETURN n; CREATE (m)",
    "MATCH (n) WITH n DETACH DELETE n RETURN 1",
    "MATCH (n) CALL { WITH n SET n.x = 1 } RETURN n",
    "WITH 1 AS x CALL apoc.cypher.run('CREATE (n)', {}) YIELD value RETURN value",
    "MATCH (n) FOREACH (x IN [1] | SET n.x = x) RETURN n",
    "INSERT (n) RETURN n",
    "SHOW TRANSACTIONS YIELD transactionId TERMINATE TRANSACTIONS transactionId",
    "RETURN 'unterminated",
    "RETURN 1 /*",
    "",
    "// read",
    "MATCH (n) RETURN 'escaped\\' quote' SET n.x = 1 RETURN n",
  ])("blocks writes, calls and incomplete input: %s", (sql) => expect(classifySqlRisk(sql, { dialect: "neo4j" }).risk).not.toBe("read"));

  it("does not enable MATCH for SQL dialects", () => expect(classifySqlRisk("MATCH (n) RETURN n", { dialect: "mysql" }).risk).not.toBe("read"));

  it.each(["WITH {set: 1, delete: 2} AS m RETURN m.set, m.delete", "MATCH (n:SET) WHERE n.remove = $delete RETURN n", "MATCH (n) RETURN n./* property */set"])("allows keyword-named identifiers: %s", (sql) => expect(classifySqlRisk(sql, { dialect: "neo4j" }).risk).toBe("read"));

  it.each([
    String.raw`MATCH (n) \u0053ET n.p = 1 RETURN n`,
    String.raw`MATCH (n) // hidden\u000ASET n.p = 1 RETURN n`,
    String.raw`MATCH (n) RETURN n.\u0060name\u0060 SET n.p = 1 RETURN n`,
    "WITH {set: 1} AS m MATCH (n) SET n.p = m.set RETURN n",
    "MATCH (n:SET) DELETE n RETURN 1",
    "MATCH (n) RETURN n.set; CALL dbms.killQuery('q')",
  ])("does not hide writes behind escapes or identifier names: %s", (sql) => expect(classifySqlRisk(sql, { dialect: "neo4j" }).risk).not.toBe("read"));
});
