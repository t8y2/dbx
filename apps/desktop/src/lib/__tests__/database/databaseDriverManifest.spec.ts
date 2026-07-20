import { describe, expect, it } from "vitest";
import { databaseRuntimeMode, usesAgentCursorForQuery } from "@/lib/database/databaseDriverManifest";

describe("databaseDriverManifest", () => {
  it("uses cursors for compatible agent or external runtimes", () => {
    expect(databaseRuntimeMode("gaussdb")).toBe("native");
    expect(usesAgentCursorForQuery("gaussdb")).toBe(false);
    expect(usesAgentCursorForQuery("mysql")).toBe(false);
    expect(usesAgentCursorForQuery("jdbc")).toBe(true);
    expect(usesAgentCursorForQuery("prestosql")).toBe(true);
  });

  it("uses server-side pagination for Kingbase queries", () => {
    expect(databaseRuntimeMode("kingbase")).toBe("agent");
    expect(usesAgentCursorForQuery("kingbase")).toBe(false);
  });
});
