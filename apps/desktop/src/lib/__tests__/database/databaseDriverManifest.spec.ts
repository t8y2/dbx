import { describe, expect, it } from "vitest";
import { databaseRuntimeMode, usesAgentCursorForQuery } from "@/lib/database/databaseDriverManifest";

describe("databaseDriverManifest", () => {
  it("uses agent cursor only for agent or external runtimes", () => {
    expect(databaseRuntimeMode("gaussdb")).toBe("native");
    expect(databaseRuntimeMode("meilisearch")).toBe("native");
    expect(usesAgentCursorForQuery("gaussdb")).toBe(false);
    expect(usesAgentCursorForQuery("meilisearch")).toBe(false);
    expect(usesAgentCursorForQuery("mysql")).toBe(false);
    expect(usesAgentCursorForQuery("jdbc")).toBe(true);
    expect(usesAgentCursorForQuery("prestosql")).toBe(true);
  });
});
