import { describe, expect, it } from "vitest";
import { buildMongoSqlCompletionItems, getMongoSqlCompletionContext, mongoSqlCompletionCollections, mongoSqlStatementCollections, shouldAutoOpenMongoSqlCompletion } from "../mongoSqlCompletion";

/** `|` marks the cursor. */
function at(textWithCursor: string) {
  const cursor = textWithCursor.indexOf("|");
  const text = textWithCursor.replace("|", "");
  return { text, cursor, context: getMongoSqlCompletionContext(text, cursor) };
}

const fields = new Map([
  [
    "users",
    [
      { name: "_id", type: "objectId" },
      { name: "address.city", type: "string" },
      { name: "mobile_number", type: "string" },
      { name: "my-field", type: "int" },
      { name: "status", type: "bool" },
    ],
  ],
  [
    "orders",
    [
      { name: "total", type: "double" },
      { name: "user_id", type: "objectId" },
    ],
  ],
]);
const labels = (textWithCursor: string, collections = ["users", "orders"]) => buildMongoSqlCompletionItems(at(textWithCursor).context, { collections, fields }).map((item) => item.label);

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

  it("offers clause keywords after the collection", () => {
    const { context } = at("SELECT * FROM users |");
    expect(context.mode).toBe("keyword");
    expect(labels("SELECT * FROM users |")).toEqual(expect.arrayContaining(["WHERE", "ORDER BY", "GROUP BY", "LIMIT", "INNER JOIN"]));
  });

  it("offers fields of the FROM collection in WHERE, even when FROM comes after the cursor", () => {
    expect(at("SELECT * FROM users WHERE mob|").context).toMatchObject({ mode: "field", clause: "where", baseCollection: "users", prefix: "mob" });
    expect(labels("SELECT * FROM users WHERE |")).toEqual(expect.arrayContaining(["mobile_number", "address.city", "AND", "LIKE", "IS NULL", "ObjectId('')"]));
    expect(at("SELECT na| FROM users").context).toMatchObject({ mode: "field", clause: "select", baseCollection: "users" });
    expect(labels("SELECT | FROM users")).toEqual(expect.arrayContaining(["status", "COUNT(*)", "SUM", "FROM"]));
  });

  it("replaces the whole dotted word and quotes awkward segments", () => {
    const { context } = at("SELECT * FROM users WHERE address.ci|ty = 'x'");
    expect(context).toMatchObject({ mode: "field", prefix: "address.ci" });
    expect(context.to - context.from).toBe("address.city".length);
    const items = buildMongoSqlCompletionItems(context, { fields });
    expect(items.find((item) => item.label === "my-field")?.apply).toBe("`my-field`");
  });

  it("knows ORDER BY / GROUP BY / HAVING", () => {
    expect(labels("SELECT * FROM users ORDER BY |")).toEqual(expect.arrayContaining(["status", "DESC", "ASC"]));
    expect(labels("SELECT status, COUNT(*) FROM users GROUP BY |")).toEqual(expect.arrayContaining(["status", "HAVING"]));
    expect(labels("SELECT status, COUNT(*) FROM users GROUP BY status HAVING |")).toEqual(expect.arrayContaining(["COUNT(*)", "AND"]));
  });

  it("resolves JOIN aliases and alias-qualified fields", () => {
    expect(mongoSqlStatementCollections("SELECT u.name FROM users u INNER JOIN orders o ON u._id = o.user_id")).toEqual({ base: "users", baseAlias: "u", joins: [{ collection: "orders", alias: "o" }] });
    const qualified = at("SELECT o.to| FROM users u JOIN orders o ON u._id = o.user_id");
    expect(qualified.context).toMatchObject({ mode: "field", prefix: "to", qualifier: { collection: "orders", alias: "o" } });
    expect(mongoSqlCompletionCollections(qualified.context)).toEqual(["orders"]);
    expect(buildMongoSqlCompletionItems(qualified.context, { fields }).map((item) => item.label)).toEqual(["total", "user_id"]);
    expect(labels("SELECT * FROM users u JOIN orders o ON u._id = o.user_id WHERE |")).toEqual(expect.arrayContaining(["status", "o.total"]));
  });

  it("uses the statement under the cursor only", () => {
    const { context } = at("SELECT * FROM orders WHERE total > 1;\nSELECT * FROM users WHERE |");
    expect(context.baseCollection).toBe("users");
  });

  it("stays quiet inside strings, numbers and LIMIT", () => {
    expect(at("SELECT * FROM users WHERE name = 'Ann|").context.mode).toBe("none");
    expect(at("SELECT * FROM users LIMIT 1|").context.mode).toBe("none");
    expect(at("SELECT * FROM users WHERE points > 10|").context.mode).toBe("none");
  });

  it("ignores keywords inside strings and comments when finding the clause", () => {
    expect(at("SELECT * FROM users WHERE note = 'from x' AND |").context).toMatchObject({ mode: "field", clause: "where", baseCollection: "users" });
    expect(at("-- FROM orders\nSELECT * FROM users WHERE |").context.baseCollection).toBe("users");
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
