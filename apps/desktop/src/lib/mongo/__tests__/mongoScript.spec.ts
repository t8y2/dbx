import { describe, expect, it } from "vitest";
import { looksLikeMongoScript } from "@/lib/mongo/mongoScript";

describe("looksLikeMongoScript", () => {
  it("recognises IIFEs, declarations and callback/cursor helpers", () => {
    for (const source of [
      "(function () { db.users.find({}).toArray(); })()",
      "(() => { return 1; })();",
      "var rows = db.users.find({}).toArray();",
      "const n = db.users.countDocuments({});",
      "db.users.find({}).forEach(function (d) { print(d._id); })",
      "db.users.find({}).toArray().map(d => d.name)",
      "// leading comment\n(function(){ })()",
      "for (var i = 0; i < 3; i++) { db.logs.insertOne({ i: i }); }",
    ]) {
      expect(looksLikeMongoScript(source), source).toBe(true);
    }
  });

  it("leaves plain shell commands and empty input to the structured parser", () => {
    for (const source of ["", "   ", "db.users.find({})", 'db.getCollection("users").aggregate([])', "show dbs", "db.users.find({"]) {
      expect(looksLikeMongoScript(source), source).toBe(false);
    }
  });
});
