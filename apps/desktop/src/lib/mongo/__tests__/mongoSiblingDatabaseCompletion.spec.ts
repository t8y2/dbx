import { describe, expect, it } from "vitest";
import { buildMongoCompletionItems, getMongoCompletionContext } from "@/lib/mongo/mongoCompletion";

function labels(text: string, cursor = text.length, collections: string[] = ["users", "orders"]) {
  return buildMongoCompletionItems(text, cursor, { collections }).map((item) => item.label);
}

describe("getSiblingDB completion targeting", () => {
  it("targets the sibling database after db.getSiblingDB(…).", () => {
    const text = 'db.getSiblingDB("archive").';
    expect(getMongoCompletionContext(text, text.length)).toMatchObject({ mode: "collection", database: "archive" });
  });

  it("accepts single quotes and whitespace-tolerant spelling", () => {
    const text = "db . getSiblingDB( 'archive' ) .";
    expect(getMongoCompletionContext(text, text.length)).toMatchObject({ mode: "collection", database: "archive" });
  });

  it("keeps the sibling target while completing a collection or a method on it", () => {
    expect(getMongoCompletionContext('db.getSiblingDB("archive").us', 30)).toMatchObject({ mode: "collection", database: "archive" });
    expect(getMongoCompletionContext('db.getSiblingDB("archive").users.', 33)).toMatchObject({ mode: "collectionOrMethod", collection: "users", database: "archive" });
  });

  it("resolves the latest sibling reference across statements", () => {
    const text = 'db.getSiblingDB("first").users.find(); db.getSiblingDB("second").';
    expect(getMongoCompletionContext(text, text.length)).toMatchObject({ mode: "collection", database: "second" });
  });

  it("leaves the database unset on plain db roots", () => {
    expect(getMongoCompletionContext("db.", 3)).toMatchObject({ mode: "collection", database: undefined });
    expect(getMongoCompletionContext("db.users.", 9)).toMatchObject({ mode: "collectionOrMethod", collection: "users", database: undefined });
  });

  it("does not offer getSiblingDB under a sibling root, but still offers it at a plain db root", () => {
    expect(labels('db.getSiblingDB("archive").')).not.toContain("getSiblingDB");
    expect(labels('db.getSiblingDB("archive").')).toContain("users");
    expect(labels("db.")).toContain("getSiblingDB");
  });

  it("does not treat a variable argument as a resolved sibling database", () => {
    const text = "db.getSiblingDB(name).";
    expect(getMongoCompletionContext(text, text.length).database).toBeUndefined();
  });
});
