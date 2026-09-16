import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../DatabaseBrowser.vue", import.meta.url), "utf8");

describe("DatabaseBrowser metadata fallback", () => {
  it("falls back to basic database names when extended metadata fails", () => {
    expect(source).toMatch(/await api\.listDatabaseMetadata\(props\.connection\.id\)[\s\S]*?catch \(metadataError\)[\s\S]*?await api\.listDatabases\(props\.connection\.id\)/);
    expect(source).toMatch(/catch \{\s*throw metadataError;\s*\}/);
  });
});
