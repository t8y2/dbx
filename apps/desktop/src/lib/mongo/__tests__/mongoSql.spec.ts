import { describe, expect, it } from "vitest";
import { compileMongoSql } from "../mongoSql";

describe("Mongo SQL compiler", () => {
  it("compiles projection, null-safe predicates, order and pagination", () => {
    const query = compileMongoSql("SELECT name, age AS years FROM people WHERE age >= 18 AND name != 'admin' ORDER BY years DESC LIMIT 20 OFFSET 10;");
    expect(query.collection).toBe("people");
    expect(query.pipeline.at(-3)).toEqual({ $sort: { years: -1 } });
    expect(query.pipeline.at(-2)).toEqual({ $skip: 10 });
    expect(query.pipeline.at(-1)).toEqual({ $limit: 20 });
    expect(query.pipeline[0]).toEqual({
      $match: {
        $expr: {
          $and: [
            { $and: [{ $ne: [{ $ifNull: ["$age", null] }, null] }, { $ne: [{ $ifNull: [{ $literal: 18 }, null] }, null] }, { $gte: ["$age", { $literal: 18 }] }] },
            { $and: [{ $ne: [{ $ifNull: ["$name", null] }, null] }, { $ne: [{ $ifNull: [{ $literal: "admin" }, null] }, null] }, { $ne: ["$name", { $literal: "admin" }] }] },
          ],
        },
      },
    });
  });
  it("supports joins and grouped aggregates without colliding with source keys", () => {
    const query = compileMongoSql("SELECT c.name AS customer, SUM(o.total) AS amount FROM orders o LEFT JOIN customers c ON o.customerId = c._id GROUP BY c.name ORDER BY amount DESC");
    expect(query.pipeline[0]).toEqual({ $replaceRoot: { newRoot: { __dbx_source: "$$ROOT" } } });
    expect(query.pipeline[1]).toMatchObject({ $lookup: { from: "customers", let: { local: "$__dbx_source.customerId" } } });
    expect(query.pipeline[2]).toMatchObject({ $unwind: { preserveNullAndEmptyArrays: true } });
    expect(query.pipeline[3]).toMatchObject({ $group: { a1: { $sum: "$__dbx_source.total" } } });
  });
  it("treats SQL literals as data and gives empty global aggregates a result", () => {
    expect(JSON.stringify(compileMongoSql("SELECT name FROM people WHERE name = '$password'").pipeline)).toContain('"$literal":"$password"');
    expect(compileMongoSql("SELECT COUNT(*) AS n FROM people").pipeline[0]).toHaveProperty("$facet");
    expect(compileMongoSql("SELECT * FROM people LIMIT 0").pipeline).toEqual([{ $match: { $expr: false } }]);
  });
  it("rejects writes, multi-statements, unsupported expressions and ambiguous joins", () => {
    for (const sql of [
      "DELETE FROM people",
      "SELECT * FROM a; DROP TABLE a",
      "SELECT a+1 FROM a",
      "SELECT * FROM a UNION SELECT * FROM b",
      "SELECT n, COUNT(*) FROM a",
      "SELECT a.x FROM a JOIN b ON x = b.x",
      "SELECT x FROM a LIMIT 1.5",
      "SELECT x FROM a WHERE x=9007199254740993",
      "SELECT DISTINCT x FROM a",
      "SELECT ALL x FROM a",
      'SELECT "a.b" AS v FROM a',
    ])
      expect(() => compileMongoSql(sql), sql).toThrow();
  });
});
