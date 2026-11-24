import { describe, expect, it } from "vitest";
import { translateMongoSqlScript } from "../mongoSql";

const sql = (text: string) => translateMongoSqlScript(text);

describe("MongoDB SQL mode: DISTINCT", () => {
  it("turns a single-column DISTINCT into a $group with a flat column", () => {
    expect(sql("SELECT DISTINCT user_type FROM users")).toBe('db.users.aggregate([{ $group: { _id: "$user_type" } }, { $project: { user_type: "$_id", _id: 0 } }])');
  });

  it("supports several columns, WHERE, ORDER BY and LIMIT", () => {
    expect(sql("SELECT DISTINCT user_type, status FROM users WHERE points > 0 ORDER BY user_type LIMIT 5")).toBe(
      'db.users.aggregate([{ $match: { points: { $gt: 0 } } }, { $group: { _id: { user_type: "$user_type", status: "$status" } } }, { $project: { user_type: "$_id.user_type", status: "$_id.status", _id: 0 } }, { $sort: { user_type: 1 } }, { $limit: 5 }])',
    );
  });

  it("rejects DISTINCT with * or aggregates, and with GROUP BY", () => {
    expect(() => sql("SELECT DISTINCT * FROM users")).toThrow(/plain columns only/);
    expect(() => sql("SELECT DISTINCT COUNT(*) FROM users")).toThrow(/plain columns only/);
    expect(() => sql("SELECT DISTINCT a FROM users GROUP BY a")).toThrow(/GROUP BY/);
  });
});

describe("MongoDB SQL mode: HAVING", () => {
  it("filters on an aggregate written as COUNT(*)", () => {
    expect(sql("SELECT user_type, COUNT(*) AS c FROM users GROUP BY user_type HAVING COUNT(*) > 5")).toBe('db.users.aggregate([{ $group: { _id: "$user_type", c: { $sum: 1 } } }, { $project: { user_type: "$_id", c: 1, _id: 0 } }, { $match: { c: { $gt: 5 } } }])');
  });

  it("filters on an alias and keeps ORDER BY after HAVING", () => {
    expect(sql("SELECT user_type, COUNT(*) AS c FROM users GROUP BY user_type HAVING c > 5 ORDER BY c DESC")).toContain("{ $match: { c: { $gt: 5 } } }, { $sort: { c: -1 } }");
  });

  it("computes an aggregate that only HAVING uses, then drops it", () => {
    const shell = sql("SELECT user_type, COUNT(*) FROM users GROUP BY user_type HAVING SUM(points) >= 100 AND user_type != 'Admin'");
    expect(shell).toContain('__having_1: { $sum: "$points" }');
    expect(shell).toContain('{ $match: { __having_1: { $gte: 100 }, user_type: { $ne: "Admin" } } }, { $unset: ["__having_1"] }');
  });

  it("works with multi-column GROUP BY and without GROUP BY", () => {
    expect(sql("SELECT user_type, status, COUNT(*) AS n FROM users GROUP BY user_type, status HAVING status = true ORDER BY status")).toBe(
      'db.users.aggregate([{ $group: { _id: { user_type: "$user_type", status: "$status" }, n: { $sum: 1 } } }, { $project: { user_type: "$_id.user_type", status: "$_id.status", n: 1, _id: 0 } }, { $match: { status: true } }, { $sort: { status: 1 } }])',
    );
    expect(sql("SELECT COUNT(*) AS n FROM users HAVING n > 1")).toBe("db.users.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])");
  });

  it("rejects HAVING on a column that is neither grouped nor aggregated", () => {
    expect(() => sql("SELECT user_type, COUNT(*) FROM users GROUP BY user_type HAVING points > 1")).toThrow(/HAVING can only use/);
    expect(() => sql("SELECT name FROM users HAVING name = 'x'")).toThrow(/HAVING requires GROUP BY/);
  });
});
