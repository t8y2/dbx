import { describe, expect, it } from "vitest";
import { buildDatabaseTreeNodes } from "@/lib/database/databaseTree";
import { spannerDisplayDatabase } from "@/lib/connection/spannerResourcePath";
import type { DatabaseInfo } from "@/types/database";

const SPANNER_PATH = "projects/test-project/instances/test-instance/databases/gsqldb";

function databases(...names: string[]): DatabaseInfo[] {
  return names.map((name) => ({ name }) as DatabaseInfo);
}

describe("buildDatabaseTreeNodes", () => {
  it("labels nodes with the reported name when no displayLabel is given", () => {
    const [node] = buildDatabaseTreeNodes("conn-1", databases("analytics"));
    expect(node.label).toBe("analytics");
    expect(node.database).toBe("analytics");
    expect(node.id).toBe("conn-1:analytics");
  });

  it("shortens the Cloud Spanner label but keeps the resource path as the node identity", () => {
    const [node] = buildDatabaseTreeNodes("conn-1", databases(SPANNER_PATH), { displayLabel: spannerDisplayDatabase });

    // Visible text is the database id only — a 60-char resource path would be
    // truncated to `projects/test-proj…` in a narrow sidebar.
    expect(node.label).toBe("gsqldb");

    // Identity must stay the full path: it round-trips to the agent as
    // ConnectParams.database, and the short name would break URL building.
    expect(node.database).toBe(SPANNER_PATH);
    expect(node.id).toBe(`conn-1:${SPANNER_PATH}`);
  });

  it("falls back to the reported name when displayLabel yields nothing", () => {
    const [node] = buildDatabaseTreeNodes("conn-1", databases("analytics"), { displayLabel: () => "" });
    expect(node.label).toBe("analytics");
  });

  it("leaves every other database type untouched when a displayLabel is absent", () => {
    const nodes = buildDatabaseTreeNodes("conn-1", databases("beta", "alpha"));
    expect(nodes.map((node) => node.label)).toEqual(["alpha", "beta"]);
  });
});
