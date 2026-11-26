import { describe, expect, it } from "vitest";
import { translateMongoSqlScript } from "../mongoSql";
import { buildMongoSqlCompletionItems, getMongoSqlCompletionContext, mongoSqlCollectionKey, mongoSqlCompletionCollections, mongoSqlStatementCollections, shouldAutoOpenMongoSqlCompletion, type MongoSqlCollectionRef } from "../mongoSqlCompletion";
import type { MongoCompletionField } from "../mongoCompletion";

/** `|` marks the cursor. */
function at(textWithCursor: string) {
  const cursor = textWithCursor.indexOf("|");
  const text = textWithCursor.replace("|", "");
  return { text, cursor, context: getMongoSqlCompletionContext(text, cursor) };
}

const fieldsFor = (entries: Array<[MongoSqlCollectionRef, MongoCompletionField[]]>) => new Map(entries.map(([ref, list]) => [mongoSqlCollectionKey(ref), list]));

const fields = fieldsFor([
  [
    { collection: "users" },
    [
      { name: "_id", type: "objectId" },
      { name: "address.city", type: "string" },
      { name: "mobile_number", type: "string" },
      { name: "my-field", type: "int" },
      { name: "status", type: "bool" },
    ],
  ],
  [
    { collection: "orders" },
    [
      { name: "total", type: "double" },
      { name: "user_id", type: "objectId" },
    ],
  ],
  [{ database: "archive", collection: "users" }, [{ name: "archived_at", type: "date" }]],
  [{ collection: "audit.logs" }, [{ name: "action", type: "string" }]],
]);
const items = (textWithCursor: string, collections = ["users", "orders"]) => buildMongoSqlCompletionItems(at(textWithCursor).context, { collections, fields });
const labels = (textWithCursor: string, collections?: string[]) => items(textWithCursor, collections).map((item) => item.label);

/** Accept the completion `label` at the cursor, like CodeMirror does with from / to / apply. */
function accept(textWithCursor: string, label: string, collections?: string[]) {
  const { text, context } = at(textWithCursor);
  const item = buildMongoSqlCompletionItems(context, { collections: collections ?? ["users", "orders"], fields }).find((candidate) => candidate.label === label);
  expect(item, `${label} offered for ${textWithCursor}`).toBeDefined();
  return text.slice(0, context.from) + (item!.apply ?? item!.label) + text.slice(context.to);
}

describe("getMongoSqlCompletionContext", () => {
  it("offers statements at the start", () => {
    expect(at("|").context.mode).toBe("statement");
    expect(at("sel|").context).toMatchObject({ mode: "statement", prefix: "sel", from: 0 });
    expect(labels("sel|")).toContain("SELECT");
  });

  it("offers collections after FROM, JOIN, UPDATE, INSERT INTO and DELETE FROM", () => {
    for (const text of ["SELECT * FROM |", "SELECT * FROM us|", "SELECT * FROM users u JOIN |", "UPDATE |", "INSERT INTO |", "DELETE FROM |"]) {
      expect(at(text).context.mode, text).toBe("collection");
    }
    expect(labels("SELECT * FROM |")).toEqual(["users", "orders"]);
  });

  it("offers fields of the FROM collection in WHERE, even when FROM comes after the cursor", () => {
    expect(at("SELECT * FROM users WHERE mob|").context).toMatchObject({ mode: "field", clause: "where", base: { collection: "users" }, prefix: "mob" });
    expect(labels("SELECT * FROM users WHERE |")).toEqual(expect.arrayContaining(["mobile_number", "address.city", "AND", "LIKE", "IS NULL", "ObjectId('')"]));
    expect(at("SELECT na| FROM users").context).toMatchObject({ mode: "field", clause: "select", base: { collection: "users" } });
    expect(labels("SELECT | FROM users")).toEqual(expect.arrayContaining(["status", "COUNT(*)", "SUM", "FROM", "*"]));
  });

  it("replaces the whole dotted word and quotes awkward segments", () => {
    const { context } = at("SELECT * FROM users WHERE address.ci|ty = 'x'");
    expect(context).toMatchObject({ mode: "field", prefix: "address.ci" });
    expect(context.to - context.from).toBe("address.city".length);
    expect(buildMongoSqlCompletionItems(context, { fields }).find((item) => item.label === "my-field")?.apply).toBe("`my-field`");
  });

  it("resolves JOIN aliases and alias-qualified fields", () => {
    expect(mongoSqlStatementCollections("SELECT u.name FROM users u INNER JOIN orders o ON u._id = o.user_id")).toEqual({ base: { collection: "users", alias: "u" }, joins: [{ collection: "orders", alias: "o" }] });
    const qualified = at("SELECT o.to| FROM users u JOIN orders o ON u._id = o.user_id");
    expect(qualified.context).toMatchObject({ mode: "field", prefix: "to", qualifier: { collection: "orders", alias: "o" } });
    expect(mongoSqlCompletionCollections(qualified.context)).toEqual([{ collection: "orders", alias: "o" }]);
    expect(buildMongoSqlCompletionItems(qualified.context, { fields }).map((item) => item.label)).toEqual(["total", "user_id"]);
    expect(labels("SELECT * FROM users u JOIN orders o ON u._id = o.user_id WHERE |")).toEqual(expect.arrayContaining(["status", "o.total"]));
  });

  it("uses the statement under the cursor only", () => {
    expect(at("SELECT * FROM orders WHERE total > 1;\nSELECT * FROM users WHERE |").context.base).toEqual({ collection: "users" });
    expect(at("SELECT * FROM users WHERE note = 'a;b' AND |").context.base).toEqual({ collection: "users" });
  });

  it("stays quiet inside strings, numbers and LIMIT", () => {
    expect(at("SELECT * FROM users WHERE name = 'Ann|").context.mode).toBe("none");
    expect(at("SELECT * FROM users LIMIT 1|").context.mode).toBe("none");
    expect(at("SELECT * FROM users WHERE points > 10|").context.mode).toBe("none");
  });

  it("ignores keywords inside strings and comments when finding the clause", () => {
    expect(at("SELECT * FROM users WHERE note = 'from x' AND |").context).toMatchObject({ mode: "field", clause: "where", base: { collection: "users" } });
    expect(at("-- FROM orders\nSELECT * FROM users WHERE |").context.base).toEqual({ collection: "users" });
  });
});

describe("database-qualified and quoted collections", () => {
  it("keeps the database qualifier so fields come from that database", () => {
    const { context } = at("SELECT * FROM archive.users WHERE |");
    expect(context.base).toEqual({ database: "archive", collection: "users" });
    expect(mongoSqlCompletionCollections(context)).toEqual([{ database: "archive", collection: "users" }]);
    const offered = labels("SELECT * FROM archive.users WHERE |");
    expect(offered).toContain("archived_at");
    expect(offered).not.toContain("mobile_number"); // the tab database's users is a different collection
  });

  it("keeps same-named collections from two databases apart in joins", () => {
    const { context } = at("SELECT * FROM users u JOIN archive.users a ON u._id = a._id WHERE |");
    expect(mongoSqlCompletionCollections(context)).toEqual([
      { collection: "users", alias: "u" },
      { database: "archive", collection: "users", alias: "a" },
    ]);
    expect(labels("SELECT * FROM users u JOIN archive.users a ON u._id = a._id WHERE |")).toEqual(expect.arrayContaining(["status", "a.archived_at"]));
  });

  it("keeps a quoted dotted collection name whole", () => {
    expect(mongoSqlStatementCollections("SELECT * FROM `audit.logs` WHERE action = 'x'").base).toEqual({ collection: "audit.logs" });
    expect(mongoSqlStatementCollections('SELECT * FROM "audit.logs"').base).toEqual({ collection: "audit.logs" });
    expect(labels("SELECT * FROM `audit.logs` WHERE |")).toContain("action");
  });

  it("lists the named database's collections after `database.`", () => {
    expect(at("SELECT * FROM archive.us|").context).toMatchObject({ mode: "collection", collectionDatabase: "archive", prefix: "us" });
    expect(at("SELECT * FROM archive.|").context).toMatchObject({ mode: "collection", collectionDatabase: "archive", prefix: "" });
    expect(accept("SELECT * FROM archive.us|", "users", ["users"])).toBe("SELECT * FROM archive.users");
  });

  it("quotes collection names that contain dots when inserting them", () => {
    const sql = accept("SELECT * FROM |", "audit.logs", ["audit.logs"]);
    expect(sql).toBe("SELECT * FROM `audit.logs`");
    expect(translateMongoSqlScript(sql)).toContain("audit.logs");
  });
});

describe("only what the compiler accepts", () => {
  it("offers SELECT clauses, not SET / VALUES, after SELECT … FROM t", () => {
    const offered = labels("SELECT * FROM users |");
    expect(offered).toEqual(["INNER JOIN", "LEFT JOIN", "WHERE", "GROUP BY", "ORDER BY", "LIMIT", "OFFSET"]);
    expect(offered).not.toContain("SET");
    expect(offered).not.toContain("VALUES");
    expect(offered).not.toContain("HAVING"); // no GROUP BY / aggregate yet
    expect(labels("SELECT status, COUNT(*) FROM users |")).toContain("HAVING");
  });

  it("offers the keyword that the statement needs after its target", () => {
    expect(labels("UPDATE users |")).toEqual(["SET"]);
    expect(labels("DELETE FROM users |")).toEqual(["WHERE"]);
    expect(labels("SELECT * FROM users u JOIN orders o |")).toEqual(["ON"]);
    expect(labels("INSERT INTO users (name) |")).toEqual(["VALUES"]);
    expect(at("INSERT INTO users |").context.mode).toBe("none");
  });

  it("does not offer later SELECT clauses in UPDATE / DELETE WHERE", () => {
    const update = labels("UPDATE users SET status = true WHERE |");
    expect(update).toEqual(expect.arrayContaining(["status", "AND"]));
    expect(update).not.toContain("ORDER BY");
    expect(update).not.toContain("GROUP BY");
    expect(labels("DELETE FROM users WHERE |")).not.toContain("LIMIT");
  });

  it("does not offer aggregates in ORDER BY, and offers directions after a field", () => {
    const orderBy = labels("SELECT status, COUNT(*) AS n FROM users GROUP BY status ORDER BY |");
    expect(orderBy).toEqual(expect.arrayContaining(["status", "n"]));
    expect(orderBy).not.toContain("COUNT(*)");
    expect(orderBy).not.toContain("SUM");
    expect(labels("SELECT * FROM users ORDER BY status |")).toEqual(["ASC", "DESC", "LIMIT", "OFFSET"]);
    expect(labels("SELECT * FROM users ORDER BY status DESC |")).toEqual(["LIMIT", "OFFSET"]);
  });

  it("offers clause order after GROUP BY and inside HAVING", () => {
    expect(labels("SELECT status, COUNT(*) FROM users GROUP BY status |")).toEqual(["HAVING", "ORDER BY", "LIMIT", "OFFSET"]);
    expect(labels("SELECT status, COUNT(*) FROM users GROUP BY status HAVING |")).toEqual(expect.arrayContaining(["COUNT(*)", "AND", "ORDER BY"]));
    expect(labels("SELECT * FROM users WHERE status = true ORDER BY status |")).not.toContain("WHERE");
  });

  it("offers JOINs and the SELECT tail after a complete ON", () => {
    expect(labels("SELECT * FROM users u JOIN orders o ON u._id = o.user_id |")).toEqual(["INNER JOIN", "LEFT JOIN", "WHERE", "GROUP BY", "ORDER BY", "LIMIT", "OFFSET"]);
  });

  it.each([
    ["SELECT * FROM users |", "WHERE", "status = true"],
    ["SELECT * FROM users |", "ORDER BY", "status"],
    ["SELECT * FROM users |", "LIMIT", "5"],
    ["SELECT status, COUNT(*) AS n FROM users GROUP BY status |", "HAVING", "n > 1"],
    ["SELECT status, COUNT(*) AS n FROM users GROUP BY status ORDER BY |", "n", ""],
    ["SELECT status, COUNT(*) AS n FROM users GROUP BY status ORDER BY n |", "DESC", ""],
    ["UPDATE users |", "SET", "status = true"],
    ["UPDATE users SET status = true |", "WHERE", "status = false"],
    ["DELETE FROM users |", "WHERE", "status = false"],
    ["INSERT INTO users (status) |", "VALUES", "(true)"],
    ["SELECT * FROM users u JOIN orders o |", "ON", "u._id = o.user_id"],
    ["SELECT * FROM archive.users WHERE |", "archived_at", " IS NULL"],
  ])("accepted suggestion compiles: %s + %s", (textWithCursor, label, rest) => {
    const sql = `${accept(textWithCursor, label)}${rest}`.trim();
    expect(() => translateMongoSqlScript(sql), sql).not.toThrow();
  });
});

describe("shouldAutoOpenMongoSqlCompletion", () => {
  const open = (textWithCursor: string) => {
    const cursor = textWithCursor.indexOf("|");
    return shouldAutoOpenMongoSqlCompletion(textWithCursor.replace("|", ""), cursor);
  };
  it("opens while typing words, after a dot, and after FROM / WHERE / AND + space", () => {
    expect(open("SELECT * FROM us|")).toBe(true);
    expect(open("SELECT * FROM |")).toBe(true);
    expect(open("SELECT * FROM archive.|")).toBe(true);
    expect(open("SELECT * FROM users WHERE |")).toBe(true);
    expect(open("SELECT * FROM users WHERE a = 1 AND |")).toBe(true);
    expect(open("SELECT * FROM users u WHERE u.|")).toBe(true);
  });
  it("stays closed after values, operators and inside strings", () => {
    expect(open("SELECT * FROM users WHERE a = |")).toBe(false);
    expect(open("SELECT * FROM users WHERE a = 'x|")).toBe(false);
    expect(open("SELECT * FROM users LIMIT 10|")).toBe(false);
  });
});
