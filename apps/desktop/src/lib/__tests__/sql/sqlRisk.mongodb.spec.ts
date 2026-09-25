import { describe, expect, it } from "vitest";
import { classifySqlRisk } from "@/lib/sql/sqlRisk";

describe("MongoDB shell statement risk", () => {
  it("treats supported read commands as reads", () => {
    for (const sql of [
      'db.getCollection("demo").find({}).skip(0).limit(100)',
      'db.getCollection("demo").findOne({"active": true})',
      'db.getCollection("demo").countDocuments({})',
      'db.getCollection("demo").aggregate([{$match: {"active": true}}])',
      'db.getCollection("demo").distinct("status")',
      'db.getCollection("demo").getIndexes()',
      'db.getCollection("demo").stats()',
      "db.version()",
      "show databases",
    ]) {
      expect(classifySqlRisk(sql, { dialect: "mongodb" }).risk, sql).toBe("read");
    }
  });

  it("keeps MongoDB writes and aggregate output stages unsafe", () => {
    for (const sql of ['db.getCollection("demo").insertOne({"active": true})', 'db.getCollection("demo").updateOne({"_id": 1}, {$set: {"active": true}})', 'db.getCollection("demo").deleteOne({"_id": 1})', 'db.getCollection("demo").aggregate([{$merge: {into: "archive"}}])']) {
      expect(classifySqlRisk(sql, { dialect: "mongodb" }).risk, sql).not.toBe("read");
    }
  });

  it.each(["", '"queryPlanner"', '"executionStats"', '"allPlansExecution"'])("treats find explain(%s) as read-only without hiding batch writes", (verbosity) => {
    const explain = `db.demo.find({}).explain(${verbosity})`;
    expect(classifySqlRisk(explain, { dialect: "mongodb" }).risk).toBe("read");
    for (const sql of [`${explain}; db.demo.insertOne({active: true})`, `db.demo.insertOne({active: true}); ${explain}`]) {
      const assessment = classifySqlRisk(sql, { dialect: "mongodb" });
      expect(assessment.risk).toBe("write");
      expect(assessment.statements.map((statement) => statement.risk)).toEqual(sql.startsWith(explain) ? ["read", "write"] : ["write", "read"]);
    }
  });

  it("retains per-command assessments for shell batches", () => {
    const assessment = classifySqlRisk('db.getCollection("demo").find({}); db.getCollection("demo").insertOne({"active": true})', { dialect: "mongodb" });
    expect(assessment.risk).toBe("write");
    expect(assessment.statements.map((statement) => statement.risk)).toEqual(["read", "write"]);
  });

  it("keeps unsupported Mongo shell commands conservative", () => {
    expect(classifySqlRisk("db.runCommand({ping: 1})", { dialect: "mongodb" }).risk).toBe("unknown");
    expect(classifySqlRisk("db.customReadHelper()", { dialect: "mongodb" }).risk).toBe("unknown");
  });
});
