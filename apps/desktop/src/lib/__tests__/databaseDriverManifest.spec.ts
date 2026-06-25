import { describe, expect, it } from "vitest";
import { databaseRuntimeMode, usesAgentCursorForQuery } from "@/lib/databaseDriverManifest";

describe("databaseDriverManifest", () => {
  it("uses agent cursor only for agent or external runtimes", () => {
    expect(databaseRuntimeMode("gaussdb")).toBe("native");
    expect(usesAgentCursorForQuery("gaussdb")).toBe(false);
    expect(usesAgentCursorForQuery("mysql")).toBe(false);
    expect(usesAgentCursorForQuery("jdbc")).toBe(true);
    expect(usesAgentCursorForQuery("prestosql")).toBe(true);
  });
});
