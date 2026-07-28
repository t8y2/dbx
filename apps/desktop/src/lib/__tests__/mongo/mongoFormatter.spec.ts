import { describe, expect, it } from "vitest";
import { formatMongoShellText, MAX_MONGO_FORMAT_CHARS } from "@/lib/mongo/mongoFormatter";

describe("mongoFormatter", () => {
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
