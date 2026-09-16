import { describe, expect, it, vi } from "vitest";
import { createSchemaDiffTableListCoordinator, createSchemaDiffTableListLoader, reconcileSchemaDiffSelectedTables, shouldLoadSchemaDiffTableList, type SchemaDiffTableIdentity, type SchemaDiffTableSide } from "@/lib/schema/schemaDiffTableList";
import type { TableInfo } from "@/types/database";

function table(name: string): TableInfo {
  return { name, table_type: "BASE TABLE" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("schemaDiffTableList", () => {
  it("keeps the unrestricted config path free of table-list requests", async () => {
    const listTables = vi.fn().mockResolvedValue([table("users")]);
    const loader = createSchemaDiffTableListLoader({ ensureConnected: vi.fn().mockResolvedValue(undefined), listTables });
    const identities: Record<SchemaDiffTableSide, SchemaDiffTableIdentity> = {
      source: { connectionId: "source", database: "app", schema: "public" },
      target: { connectionId: "target", database: "app", schema: "public" },
    };
    const coordinator = createSchemaDiffTableListCoordinator({
      loader,
      getIdentity: (side) => identities[side],
      setTables: vi.fn(),
    });

    await coordinator.refresh("source", shouldLoadSchemaDiffTableList("source", false, 0, true));
    await coordinator.refresh("target", shouldLoadSchemaDiffTableList("target", false, 0, true));

    expect(listTables).not.toHaveBeenCalled();
    expect(shouldLoadSchemaDiffTableList("target", true, 0, true)).toBe(false);
  });

  it("loads each side at most once for non-refreshing reads", async () => {
    const listTables = vi.fn(async (connectionId: string) => [table(`${connectionId}_table`)]);
    const loader = createSchemaDiffTableListLoader({ ensureConnected: vi.fn().mockResolvedValue(undefined), listTables });
    const identities: Record<SchemaDiffTableSide, SchemaDiffTableIdentity> = {
      source: { connectionId: "source", database: "app", schema: "public" },
      target: { connectionId: "target", database: "app", schema: "public" },
    };
    const coordinator = createSchemaDiffTableListCoordinator({
      loader,
      getIdentity: (side) => identities[side],
      setTables: vi.fn(),
    });

    await coordinator.refresh("source", shouldLoadSchemaDiffTableList("source", true, 0, true));
    await coordinator.refresh("target", shouldLoadSchemaDiffTableList("target", true, 1, true));
    await Promise.all([loader.load(identities.source), loader.load(identities.target)]);

    expect(listTables).toHaveBeenCalledTimes(2);
    expect(listTables).toHaveBeenCalledWith("source", "app", "public");
    expect(listTables).toHaveBeenCalledWith("target", "app", "public");
  });

  it("refreshes table names before a second compare after the database changes", async () => {
    const listTables = vi
      .fn()
      .mockResolvedValueOnce([table("removed_table")])
      .mockResolvedValueOnce([table("current_table")]);
    const loader = createSchemaDiffTableListLoader({ ensureConnected: vi.fn().mockResolvedValue(undefined), listTables });
    const identity: SchemaDiffTableIdentity = { connectionId: "source", database: "app", schema: "public" };

    const firstTables = await loader.load(identity);
    const refreshedTables = await loader.load(identity, { refresh: true });

    expect(firstTables.map((entry) => entry.name)).toEqual(["removed_table"]);
    expect(refreshedTables.map((entry) => entry.name)).toEqual(["current_table"]);
    expect(listTables).toHaveBeenCalledTimes(2);
  });

  it("prunes deleted selections only after a successful source load", async () => {
    const listTables = vi.fn(async (_connectionId: string, database: string) => {
      if (database === "unavailable") throw new Error("offline");
      return [table("users")];
    });
    const loader = createSchemaDiffTableListLoader({ ensureConnected: vi.fn().mockResolvedValue(undefined), listTables });
    let sourceIdentity: SchemaDiffTableIdentity = { connectionId: "source", database: "app", schema: "public" };
    let selectedTables = ["deleted_table"];
    const coordinator = createSchemaDiffTableListCoordinator({
      loader,
      getIdentity: () => sourceIdentity,
      setTables: vi.fn(),
      onSourceTablesLoaded: (tables) => {
        selectedTables = reconcileSchemaDiffSelectedTables(
          selectedTables,
          tables.map((entry) => entry.name),
        );
      },
    });

    await coordinator.refresh("source", true);
    expect(selectedTables).toEqual([]);

    selectedTables = ["keep_on_error"];
    sourceIdentity = { ...sourceIdentity, database: "unavailable" };
    await coordinator.refresh("source", true);
    expect(selectedTables).toEqual(["keep_on_error"]);
  });

  it("ignores an older response after the source identity changes", async () => {
    const sourceA = deferred<TableInfo[]>();
    const sourceB = deferred<TableInfo[]>();
    const listTables = vi.fn((_connectionId: string, database: string) => (database === "a" ? sourceA.promise : sourceB.promise));
    const loader = createSchemaDiffTableListLoader({ ensureConnected: vi.fn().mockResolvedValue(undefined), listTables });
    let sourceIdentity: SchemaDiffTableIdentity = { connectionId: "source", database: "a", schema: "public" };
    let visibleTables: TableInfo[] = [];
    const coordinator = createSchemaDiffTableListCoordinator({
      loader,
      getIdentity: () => sourceIdentity,
      setTables: (_side, tables) => {
        visibleTables = tables;
      },
    });

    const loadA = coordinator.refresh("source", true);
    sourceIdentity = { ...sourceIdentity, database: "b" };
    const loadB = coordinator.refresh("source", true);

    sourceB.resolve([table("b_table")]);
    await loadB;
    sourceA.resolve([table("a_table")]);
    await loadA;

    expect(visibleTables.map((entry) => entry.name)).toEqual(["b_table"]);
  });
});
