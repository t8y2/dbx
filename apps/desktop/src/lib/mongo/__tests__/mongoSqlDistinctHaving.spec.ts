import { describe, expect, it } from "vitest";
import { translateMongoSqlScript } from "../mongoSql";

const sql = (text: string) => translateMongoSqlScript(text);
const pipeline = (text: string) => {
  const match = /^db\.\w+\.aggregate\((.*)\)$/s.exec(sql(text));
  if (!match) throw new Error(`not an aggregate: ${sql(text)}`);
  return match[1]!;
};

describe("MongoDB SQL mode: DISTINCT", () => {
  it("turns a single-column DISTINCT into a $group with a flat column", () => {
    expect(sql("SELECT DISTINCT user_type FROM users")).toBe('db.users.aggregate([{ $group: { _id: "$user_type" } }, { $project: { user_type: "$_id", _id: 0 } }])');
  });

  it("supports several columns, WHERE, ORDER BY and LIMIT", () => {
    expect(sql("SELECT DISTINCT user_type, status FROM users WHERE points > 0 ORDER BY user_type LIMIT 5")).toBe(
      'db.users.aggregate([{ $match: { points: { $gt: 0 } } }, { $group: { _id: { user_type: "$user_type", status: "$status" } } }, { $sort: { "_id.user_type": 1 } }, { $project: { user_type: "$_id.user_type", status: "$_id.status", _id: 0 } }, { $limit: 5 }])',
    );
  });

  it("keeps an explicitly selected _id", () => {
    expect(sql("SELECT DISTINCT _id FROM users")).toBe('db.users.aggregate([{ $group: { _id: "$_id" } }, { $project: { _id: "$_id" } }])');
    expect(sql("SELECT DISTINCT _id, status FROM users")).toBe('db.users.aggregate([{ $group: { _id: { _id: "$_id", status: "$status" } } }, { $project: { _id: "$_id._id", status: "$_id.status" } }])');
  });

  it("rejects DISTINCT with * or aggregates, and with GROUP BY", () => {
    expect(() => sql("SELECT DISTINCT * FROM users")).toThrow(/plain columns only/);
    expect(() => sql("SELECT DISTINCT COUNT(*) FROM users")).toThrow(/plain columns only/);
    expect(() => sql("SELECT DISTINCT a FROM users GROUP BY a")).toThrow(/GROUP BY/);
  });
});

describe("MongoDB SQL mode: HAVING", () => {
  it("filters on an aggregate written as COUNT(*)", () => {
    expect(sql("SELECT user_type, COUNT(*) AS c FROM users GROUP BY user_type HAVING COUNT(*) > 5")).toBe('db.users.aggregate([{ $group: { _id: "$user_type", c: { $sum: 1 } } }, { $match: { c: { $gt: 5 } } }, { $project: { user_type: "$_id", c: 1, _id: 0 } }])');
  });

  it("keeps HAVING on the COUNT(*) path instead of countDocuments", () => {
    // Without HAVING the shortcut is still used.
    expect(sql("SELECT COUNT(*) FROM users")).toBe("db.users.countDocuments({})");
    // With HAVING the single grouped row is filtered: 3 documents and `> 5` yield no row, `> 2` yields one.
    expect(sql("SELECT COUNT(*) FROM users HAVING COUNT(*) > 5")).toBe("db.users.aggregate([{ $group: { _id: null, count: { $sum: 1 } } }, { $match: { count: { $gt: 5 } } }])");
    expect(sql("SELECT COUNT(*) FROM users HAVING COUNT(*) > 2")).toBe("db.users.aggregate([{ $group: { _id: null, count: { $sum: 1 } } }, { $match: { count: { $gt: 2 } } }])");
  });

  it("filters on an alias and sorts before $project", () => {
    expect(pipeline("SELECT user_type, COUNT(*) AS c FROM users GROUP BY user_type HAVING c > 5 ORDER BY c DESC")).toContain("{ $match: { c: { $gt: 5 } } }, { $sort: { c: -1 } }, { $project:");
  });

  it("keeps GROUP BY columns that are not selected available to HAVING and ORDER BY", () => {
    expect(sql("SELECT status, COUNT(*) FROM users GROUP BY status, region HAVING region = 'APAC'")).toBe(
      'db.users.aggregate([{ $group: { _id: { status: "$status", region: "$region" }, count: { $sum: 1 } } }, { $match: { "_id.region": "APAC" } }, { $project: { status: "$_id.status", count: 1, _id: 0 } }])',
    );
    expect(sql("SELECT status, COUNT(*) FROM users GROUP BY status, region ORDER BY region")).toBe('db.users.aggregate([{ $group: { _id: { status: "$status", region: "$region" }, count: { $sum: 1 } } }, { $sort: { "_id.region": 1 } }, { $project: { status: "$_id.status", count: 1, _id: 0 } }])');
    // A SELECT alias of a group column resolves to the group key.
    expect(pipeline("SELECT status AS s, COUNT(*) AS n FROM users GROUP BY status HAVING s = 'A' ORDER BY s")).toContain('{ $match: { _id: "A" } }, { $sort: { _id: 1 } }, { $project: { s: "$_id", n: 1, _id: 0 } }');
  });

  it("computes an aggregate that only HAVING uses and leaves it out of the output", () => {
    const shell = sql("SELECT user_type, COUNT(*) FROM users GROUP BY user_type HAVING SUM(points) >= 100 AND user_type != 'Admin'");
    expect(shell).toContain('__having_1: { $sum: "$points" }');
    expect(shell).toContain('{ $match: { __having_1: { $gte: 100 }, _id: { $ne: "Admin" } } }, { $project: { user_type: "$_id", count: 1, _id: 0 } }');
    // Without a $project the hidden accumulator is removed with $unset.
    expect(sql("SELECT COUNT(*) AS n FROM users HAVING SUM(points) > 1")).toBe('db.users.aggregate([{ $group: { _id: null, n: { $sum: 1 }, __having_1: { $sum: "$points" } } }, { $match: { __having_1: { $gt: 1 } } }, { $unset: ["__having_1"] }])');
  });

  it("gives each array index its own accumulator and reads the element with $arrayElemAt", () => {
    const shell = sql("SELECT SUM(items[0].price) FROM orders HAVING SUM(items[1].price) > 100");
    expect(shell).toContain('sum_price: { $sum: { $getField: { field: "price", input: { $arrayElemAt: ["$items", 0] } } } }');
    expect(shell).toContain('__having_1: { $sum: { $getField: { field: "price", input: { $arrayElemAt: ["$items", 1] } } } }');
    expect(shell).toContain("{ $match: { __having_1: { $gt: 100 } } }");
    // The same expression is still reused.
    expect(sql("SELECT SUM(items[0].price) AS s FROM orders HAVING SUM(items[0].price) > 1")).not.toContain("__having");
  });

  it("works with multi-column GROUP BY and without GROUP BY", () => {
    expect(sql("SELECT user_type, status, COUNT(*) AS n FROM users GROUP BY user_type, status HAVING status = true ORDER BY status")).toBe(
      'db.users.aggregate([{ $group: { _id: { user_type: "$user_type", status: "$status" }, n: { $sum: 1 } } }, { $match: { "_id.status": true } }, { $sort: { "_id.status": 1 } }, { $project: { user_type: "$_id.user_type", status: "$_id.status", n: 1, _id: 0 } }])',
    );
    expect(sql("SELECT COUNT(*) AS n FROM users HAVING n > 1")).toBe("db.users.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])");
  });

  it("rejects HAVING / ORDER BY on a column that is neither grouped nor aggregated", () => {
    expect(() => sql("SELECT user_type, COUNT(*) FROM users GROUP BY user_type HAVING points > 1")).toThrow(/HAVING can only use/);
    expect(() => sql("SELECT status, COUNT(*) FROM users GROUP BY status ORDER BY points")).toThrow(/ORDER BY can only use/);
    expect(() => sql("SELECT name FROM users HAVING name = 'x'")).toThrow(/HAVING requires GROUP BY/);
  });
});
