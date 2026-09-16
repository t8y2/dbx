import { describe, expect, it } from "vitest";
import { formatMongoShellText, MAX_MONGO_FORMAT_CHARS } from "@/lib/mongo/mongoFormatter";

describe("mongoFormatter", () => {
  it("separates top-level Mongo shell statements", () => {
    const query = `db.order_full_link_trace_log.find({
  traceId:"master-order:63907695457"
});

db.order_full_link_trace_log.find({}).sort({
  masterOrderId:-1
});

db.order_full_link_trace_log.find({
  masterOrderId:63907756017
});`;

    expect(formatMongoShellText(query)).toBe(`db.order_full_link_trace_log.find({
  traceId: "master-order:63907695457"
});

db.order_full_link_trace_log.find({})
  .sort({
    masterOrderId: -1
  });

db.order_full_link_trace_log.find({
  masterOrderId: 63907756017
});`);
  });

  it("normalizes existing statement spacing and remains idempotent", () => {
    const expected = "db.first.find({});\n\ndb.second.find({});";

    expect(formatMongoShellText("db.first.find({}); db.second.find({});")).toBe(expected);
    expect(formatMongoShellText("db.first.find({});\n\n\n db.second.find({});")).toBe(expected);
    expect(formatMongoShellText(expected)).toBe(expected);
  });

  it("leaves a single statement unchanged", () => {
    expect(formatMongoShellText("db.items.find({});")).toBe("db.items.find({});");
  });

  it("does not treat semicolons inside nested syntax or literals as statement boundaries", () => {
    const formatted = formatMongoShellText(`db.items.find({
  text:"a;b",
  pattern:/a;b/,
  $where:function(){const ids=[1,2];return ids.length>0;}
});db.logs.find({});`);

    expect(formatted).toContain('text: "a;b"');
    expect(formatted).toContain("pattern: /a;b/");
    expect(formatted).toContain("const ids=[");
    expect(formatted).toContain("];return ids.length>0;");
    expect(formatted.split("\n\n")).toHaveLength(2);
  });

  it("keeps trailing comments attached to their statement", () => {
    const formatted = formatMongoShellText("db.first.find({}); // keep; this comment\ndb.second.find({}); /* keep; this too */ db.third.find({});");

    expect(formatted).toBe("db.first.find({}); // keep; this comment\n\ndb.second.find({}); /* keep; this too */\n\ndb.third.find({});");
  });

  it("keeps the statement after a standalone line comment executable", () => {
    const expected = "db.first.find({});\n\n// comment for next statement\ndb.second.find({});";

    expect(formatMongoShellText("db.first.find({});\n// comment for next statement\ndb.second.find({});")).toBe(expected);
    expect(formatMongoShellText("db.first.find({});\r\n// comment for next statement\r\ndb.second.find({});")).toBe(expected);
    expect(formatMongoShellText(expected)).toBe(expected);
  });

  it("does not add a line break after a final line comment", () => {
    expect(formatMongoShellText("db.first.find({}); // final comment")).toBe("db.first.find({}); // final comment");
  });

  it("formats documents with many short fields without repeated whole-output rewrites", () => {
    const fields = Array.from({ length: 20_000 }, (_, index) => `"field${index}":${index}`).join(",");
    const query = `db.items.insert({${fields}});`;

    const formatted = formatMongoShellText(query);

    expect(formatted).toContain('"field0": 0');
    expect(formatted).toContain('"field19999": 19999');
    expect(formatted.length).toBeGreaterThan(query.length);
  });

  it("rejects input beyond the formatter safety limit", () => {
    expect(() => formatMongoShellText("x".repeat(MAX_MONGO_FORMAT_CHARS + 1))).toThrow("MongoDB query is too large to format safely.");
  });
});
