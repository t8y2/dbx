import { describe, expect, it } from "vitest";
import { shellLineCommentRanges } from "@/lib/editor/shellLineCommentRanges";

function commentTexts(doc: string): string[] {
  return shellLineCommentRanges(doc).map((range) => doc.slice(range.from, range.to));
}

describe("shellLineCommentRanges", () => {
  it("finds a whole-line comment", () => {
    expect(commentTexts("// list users\ndb.users.find({})")).toEqual(["// list users"]);
  });

  it("finds a trailing comment and stops at the line end", () => {
    expect(commentTexts("db.users.find({}) // only active\ndb.users.count()")).toEqual(["// only active"]);
  });

  it("ignores // inside quoted strings", () => {
    expect(commentTexts('db.sites.insertOne({ url: "https://example.com" })')).toEqual([]);
    expect(commentTexts("db.sites.insertOne({ url: 'https://example.com' })")).toEqual([]);
    expect(commentTexts("db.sites.insertOne({ url: `https://example.com` })")).toEqual([]);
  });

  it("ignores // inside block comments", () => {
    expect(commentTexts("/* db.users.find({}) // stale */\ndb.users.count()")).toEqual([]);
  });

  it("handles escaped quotes without swallowing the rest of the document", () => {
    expect(commentTexts('db.t.find({ a: "x\\"y" }) // note')).toEqual(["// note"]);
  });

  it("does not let an unterminated quote hide later comments", () => {
    expect(commentTexts('db.t.find({ a: "oops\n// note')).toEqual(["// note"]);
  });

  it("keeps carriage returns out of the range", () => {
    expect(commentTexts("// note\r\ndb.users.count()")).toEqual(["// note"]);
  });

  it("respects the scan limit", () => {
    const doc = "db.a.find()\n// second line";
    expect(shellLineCommentRanges(doc, doc.indexOf("//"))).toEqual([]);
  });
});
