import { describe, expect, it, vi } from "vitest";
import { loadFavoritesParentContent, pickFavoritesParentLoader, type FavoritesParentLoaders } from "@/lib/app/favorites/parentLoading";
import type { ConnectionConfig } from "@/types/database";

function buildLoaders(overrides: Partial<FavoritesParentLoaders> = {}): FavoritesParentLoaders & {
  loadTables: ReturnType<typeof vi.fn>;
  loadSchemas: ReturnType<typeof vi.fn>;
  loadSqlServerDatabaseObjects: ReturnType<typeof vi.fn>;
  getConfig: ReturnType<typeof vi.fn>;
} {
  return {
    loadTables: vi.fn().mockResolvedValue(undefined),
    loadSchemas: vi.fn().mockResolvedValue(undefined),
    loadSqlServerDatabaseObjects: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn().mockReturnValue(undefined),
    ...overrides,
  };
}

const baseConfig: ConnectionConfig = {
  id: "c1",
  name: "C1",
  db_type: "postgres",
  host: "h",
  port: 5432,
  username: "u",
  password: "p",
};

describe("pickFavoritesParentLoader", () => {
  it("returns null when the placeholder has no connection or database", () => {
    const loaders = buildLoaders();
    expect(pickFavoritesParentLoader({ connectionId: undefined, database: undefined }, loaders)).toBeNull();
    expect(pickFavoritesParentLoader({ connectionId: "c1", database: undefined }, loaders)).toBeNull();
    expect(pickFavoritesParentLoader({ connectionId: undefined, database: "a" }, loaders)).toBeNull();
  });

  it("uses loadTables(schema) when the placeholder sits under a schema", () => {
    const loaders = buildLoaders();
    const invoke = pickFavoritesParentLoader({ connectionId: "c1", database: "a", schema: "public" }, loaders);
    expect(invoke).not.toBeNull();
    invoke!();
    expect(loaders.loadTables).toHaveBeenCalledWith("c1", "a", "public");
    expect(loaders.loadSchemas).not.toHaveBeenCalled();
  });

  it("uses loadSqlServerDatabaseObjects for sqlserver connections", () => {
    const loaders = buildLoaders({ getConfig: vi.fn().mockReturnValue({ ...baseConfig, db_type: "sqlserver" }) });
    const invoke = pickFavoritesParentLoader({ connectionId: "c1", database: "a" }, loaders);
    invoke!();
    expect(loaders.loadSqlServerDatabaseObjects).toHaveBeenCalledWith("c1", "a");
    expect(loaders.loadTables).not.toHaveBeenCalled();
  });

  it("uses loadSchemas for databases running in tree-schema mode", () => {
    const loaders = buildLoaders({ getConfig: vi.fn().mockReturnValue({ ...baseConfig, db_type: "postgres" }) });
    const invoke = pickFavoritesParentLoader({ connectionId: "c1", database: "a" }, loaders);
    invoke!();
    expect(loaders.loadSchemas).toHaveBeenCalledWith("c1", "a");
    expect(loaders.loadTables).not.toHaveBeenCalled();
  });

  it("uses loadTables for the simple flat mode (mysql/sqlite/...)", () => {
    const loaders = buildLoaders({ getConfig: vi.fn().mockReturnValue({ ...baseConfig, db_type: "mysql" }) });
    const invoke = pickFavoritesParentLoader({ connectionId: "c1", database: "a" }, loaders);
    invoke!();
    expect(loaders.loadTables).toHaveBeenCalledWith("c1", "a");
  });

  it("prefers loadSchemas over loadTables when the connection is a sqlserver-like database that uses the schema tree", () => {
    // The tree-schema routing should still win when the connection opts in,
    // so a sqlserver config with `useSchemaTree` should land on
    // `loadSchemas`. (Mirrors the toggle path's precedence.)
    const loaders = buildLoaders({ getConfig: vi.fn().mockReturnValue({ ...baseConfig, db_type: "sqlserver" }) });
    // The actual toggle path always goes through `loadSqlServerDatabaseObjects`
    // for sqlserver, so this is just a sanity check that we don't fall
    // through to the flat-table loader by accident.
    const invoke = pickFavoritesParentLoader({ connectionId: "c1", database: "a" }, loaders);
    invoke!();
    expect(loaders.loadSqlServerDatabaseObjects).toHaveBeenCalledOnce();
  });
});

describe("loadFavoritesParentContent", () => {
  it("returns false without invoking any loader when the node lacks scope", async () => {
    const loaders = buildLoaders();
    const ok = await loadFavoritesParentContent({ connectionId: undefined, database: undefined }, loaders);
    expect(ok).toBe(false);
    expect(loaders.loadTables).not.toHaveBeenCalled();
    expect(loaders.loadSchemas).not.toHaveBeenCalled();
    expect(loaders.loadSqlServerDatabaseObjects).not.toHaveBeenCalled();
  });

  it("returns true and forwards to the chosen loader", async () => {
    const loaders = buildLoaders({ getConfig: vi.fn().mockReturnValue({ ...baseConfig, db_type: "mysql" }) });
    const ok = await loadFavoritesParentContent({ connectionId: "c1", database: "a" }, loaders);
    expect(ok).toBe(true);
    expect(loaders.loadTables).toHaveBeenCalledWith("c1", "a");
  });
});
