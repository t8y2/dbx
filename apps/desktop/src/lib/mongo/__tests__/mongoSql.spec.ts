import { describe, expect, it } from "vitest";
import { splitMongoCommandRanges } from "@/lib/mongo/mongoShellCommand";
import { MongoSqlError, prepareMongoQueryText, translateMongoSqlScript } from "@/lib/mongo/mongoSql";

function shell(sql: string) {
  const text = translateMongoSqlScript(sql);
  const commands = splitMongoCommandRanges(text);
  expect(commands, text).toHaveLength(1);
  return { text, command: commands[0]!.command };
}

describe("translateMongoSqlScript", () => {
  it("compiles a filtered, sorted, limited select into find", () => {
    const { command } = shell("SELECT name, email FROM users WHERE age > 30 ORDER BY name LIMIT 50");
    expect(command.kind).toBe("find");
    if (command.kind !== "find") return;
    expect(command.collection).toBe("users");
    expect(JSON.parse(command.filter)).toEqual({ age: { $gt: 30 } });
    expect(JSON.parse(command.projection ?? "{}")).toEqual({ name: 1, email: 1, _id: 0 });
    expect(JSON.parse(command.sort ?? "{}")).toEqual({ name: 1 });
    expect(command.limit).toBe(50);
  });

  it("keeps ObjectId and ISODate constructors in the filter", () => {
    const { text, command } = shell("SELECT * FROM users WHERE _id = ObjectId('507f1f77bcf86cd799439011') AND created = ISODate('2020-01-02T03:04:05Z')");
    expect(text).toContain("ObjectId(\"507f1f77bcf86cd799439011\")");
    expect(text).toContain("ISODate(\"2020-01-02T03:04:05Z\")");
    expect(command.kind).toBe("find");
    if (command.kind !== "find") return;
    expect(JSON.parse(command.filter)).toEqual({
      _id: { $oid: "507f1f77bcf86cd799439011" },
      created: { $date: "2020-01-02T03:04:05Z" },
    });
  });

  it("compiles GROUP BY aggregates into an aggregation pipeline", () => {
    const { command } = shell("SELECT status, COUNT(*) AS n FROM users WHERE active = true GROUP BY status ORDER BY n DESC");
    expect(command.kind).toBe("aggregate");
    if (command.kind !== "aggregate") return;
    expect(JSON.parse(command.pipeline)).toEqual([
      { $match: { active: true } },
      { $group: { _id: "$status", n: { $sum: 1 } } },
      { $project: { status: "$_id", n: 1, _id: 0 } },
      { $sort: { n: -1 } },
    ]);
  });

  it("compiles an equality join into $lookup", () => {
    const { command } = shell("SELECT * FROM orders o INNER JOIN customers c ON o.customer_id = c._id WHERE o.total > 10");
    expect(command.kind).toBe("aggregate");
    if (command.kind !== "aggregate") return;
    const pipeline = JSON.parse(command.pipeline) as Array<Record<string, unknown>>;
    expect(pipeline[0]).toEqual({ $match: { total: { $gt: 10 } } });
    expect(pipeline[1]).toEqual({ $lookup: { from: "customers", localField: "customer_id", foreignField: "_id", as: "c" } });
    expect(pipeline[2]).toEqual({ $unwind: { path: "$c", preserveNullAndEmptyArrays: false } });
  });

  it("compiles writes into insertMany, updateMany, and deleteMany", () => {
    const inserted = shell("INSERT INTO users (name, age) VALUES ('ada', 36), ('bea', 41)");
    expect(inserted.command.kind).toBe("insert");
    if (inserted.command.kind === "insert") {
      expect(JSON.parse(inserted.command.docsJson)).toEqual([
        { name: "ada", age: 36 },
        { name: "bea", age: 41 },
      ]);
    }

    const updated = shell("UPDATE users SET age = 31 WHERE name = 'ada'");
    expect(updated.command.kind).toBe("update");
    if (updated.command.kind === "update") {
      expect(updated.command.many).toBe(true);
      expect(JSON.parse(updated.command.filter)).toEqual({ name: "ada" });
      expect(JSON.parse(updated.command.update)).toEqual({ $set: { age: 31 } });
    }

    const deleted = shell("DELETE FROM users WHERE age < 18");
    expect(deleted.command.kind).toBe("delete");
    if (deleted.command.kind === "delete") {
      expect(deleted.command.many).toBe(true);
      expect(JSON.parse(deleted.command.filter)).toEqual({ age: { $lt: 18 } });
    }
  });

  it("translates each statement and leaves an existing shell command untouched", () => {
    const script = translateMongoSqlScript("SELECT * FROM users LIMIT 5; DELETE FROM users WHERE inactive = true");
    expect(splitMongoCommandRanges(script)).toHaveLength(2);
    const generated = translateMongoSqlScript("SELECT * FROM users");
    expect(prepareMongoQueryText(generated, "sql", "mongodb", generated)).toEqual({ sql: generated });
    expect(() => prepareMongoQueryText("db.users.drop()", "sql", "mongodb")).toThrow(MongoSqlError);
    expect(prepareMongoQueryText("SELECT * FROM users", "sql", "mysql").sql).toBe("SELECT * FROM users");
  });

  it("compiles array indexes in filters and projections", () => {
    const filtered = shell("SELECT * FROM orders WHERE addresses[0].city = 'SP' ORDER BY items[0].name");
    expect(filtered.command.kind).toBe("find");
    if (filtered.command.kind !== "find") return;
    expect(JSON.parse(filtered.command.filter)).toEqual({ "addresses.0.city": "SP" });
    expect(JSON.parse(filtered.command.sort ?? "{}")).toEqual({ "items.0.name": 1 });

    const projected = shell("SELECT items[0].name FROM orders");
    expect(projected.command.kind).toBe("find");
    if (projected.command.kind !== "find") return;
    expect(JSON.parse(projected.command.projection ?? "{}")).toEqual({
      "items.0.name": { $getField: { field: "name", input: { $arrayElemAt: ["$items", 0] } } },
      _id: 0,
    });

    const updated = shell("UPDATE orders SET items[0].name = 'kit' WHERE addresses[0].city = 'SP'");
    expect(updated.command.kind).toBe("update");
    if (updated.command.kind !== "update") return;
    expect(JSON.parse(updated.command.filter)).toEqual({ "addresses.0.city": "SP" });
    expect(JSON.parse(updated.command.update)).toEqual({ $set: { "items.0.name": "kit" } });
  });

  it("keeps dotted ORDER BY paths and allows reserved words as names", () => {
    const nested = shell("SELECT name FROM users ORDER BY address.city");
    expect(nested.command.kind).toBe("find");
    if (nested.command.kind !== "find") return;
    expect(JSON.parse(nested.command.sort ?? "{}")).toEqual({ "address.city": 1 });

    const qualified = shell("SELECT user.name FROM users ORDER BY user.name");
    expect(qualified.command.kind).toBe("find");
    if (qualified.command.kind !== "find") return;
    expect(JSON.parse(qualified.command.sort ?? "{}")).toEqual({ "user.name": 1 });
    expect(JSON.parse(qualified.command.projection ?? "{}")).toEqual({ "user.name": 1, _id: 0 });

    const renamed = shell("SELECT address.city AS city FROM users ORDER BY address.city");
    expect(renamed.command.kind).toBe("aggregate");
    if (renamed.command.kind !== "aggregate") return;
    expect(JSON.parse(renamed.command.pipeline)).toEqual([
      { $sort: { "address.city": 1 } },
      { $project: { city: "$address.city", _id: 0 } },
    ]);

    const named = shell("SELECT window FROM window WHERE over = 1");
    expect(named.command.kind).toBe("find");
    if (named.command.kind !== "find") return;
    expect(JSON.parse(named.command.filter)).toEqual({ over: 1 });
  });

  it("strips table qualifiers from find projections", () => {
    const aliased = shell("SELECT u.name FROM users u");
    expect(aliased.command.kind).toBe("find");
    if (aliased.command.kind !== "find") return;
    expect(JSON.parse(aliased.command.projection ?? "{}")).toEqual({ name: 1, _id: 0 });

    const collection = shell("SELECT users.name FROM users");
    expect(collection.command.kind).toBe("find");
    if (collection.command.kind !== "find") return;
    expect(JSON.parse(collection.command.projection ?? "{}")).toEqual({ name: 1, _id: 0 });
  });

  it("keeps join owners in GROUP BY and aggregate fields", () => {
    const grouped = shell("SELECT c.name, SUM(c.total) AS total FROM orders o INNER JOIN customers c ON o.customer_id = c._id GROUP BY c.name");
    expect(grouped.command.kind).toBe("aggregate");
    if (grouped.command.kind !== "aggregate") return;
    const pipeline = JSON.parse(grouped.command.pipeline) as Array<Record<string, unknown>>;
    expect(pipeline.find((stage) => "$group" in stage)).toEqual({ $group: { _id: "$c.name", total: { $sum: "$c.total" } } });

    const multi = shell("SELECT a.x, b.x FROM lefts a INNER JOIN rights b ON a.id = b.id GROUP BY a.x, b.x");
    expect(multi.command.kind).toBe("aggregate");
    if (multi.command.kind !== "aggregate") return;
    const stages = JSON.parse(multi.command.pipeline) as Array<Record<string, unknown>>;
    expect(stages.find((stage) => "$group" in stage)).toEqual({ $group: { _id: { x: "$x", b: { x: "$b.x" } } } });

    const nested = shell("SELECT address.city, profile.city FROM users GROUP BY address.city, profile.city");
    expect(nested.command.kind).toBe("aggregate");
    if (nested.command.kind !== "aggregate") return;
    const nestedStages = JSON.parse(nested.command.pipeline) as Array<Record<string, unknown>>;
    expect(nestedStages.find((stage) => "$group" in stage)).toEqual({
      $group: { _id: { address: { city: "$address.city" }, profile: { city: "$profile.city" } } },
    });
  });

  it("sorts before a projection removes the sort field", () => {
    const { command } = shell("SELECT name AS n FROM users ORDER BY age");
    expect(command.kind).toBe("aggregate");
    if (command.kind !== "aggregate") return;
    expect(JSON.parse(command.pipeline)).toEqual([
      { $sort: { age: 1 } },
      { $project: { n: "$name", _id: 0 } },
    ]);
  });

  it("rejects negative array indexes on the query path", () => {
    expect(() => translateMongoSqlScript("SELECT * FROM orders WHERE items[-1].name = 'kit'")).toThrow(/Negative array indexes/);
    const projected = shell("SELECT items[-1].name FROM orders");
    expect(projected.command.kind).toBe("find");
    if (projected.command.kind !== "find") return;
    expect(JSON.parse(projected.command.projection ?? "{}")).toEqual({
      "items.-1.name": { $getField: { field: "name", input: { $arrayElemAt: ["$items", -1] } } },
      _id: 0,
    });
  });

  it("rejects SQL outside the supported subset", () => {
    expect(() => translateMongoSqlScript("SELECT * FROM users UNION SELECT * FROM archived")).toThrow(MongoSqlError);
    expect(() => translateMongoSqlScript("SELECT name, ROW_NUMBER() OVER (ORDER BY name) FROM users")).toThrow(/Window functions/);
    expect(() => translateMongoSqlScript("SELECT * FROM users WHERE id IN (SELECT id FROM archived)")).toThrow(/Subqueries/);
    expect(() => translateMongoSqlScript("WITH recent AS (SELECT * FROM users) SELECT * FROM recent")).toThrow(/WITH/);
  });
});
