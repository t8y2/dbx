import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { tableTabFavoriteMenuItems } from "../tabMenu";
import { favoriteTargetFromNode } from "../target";
import { encodeSqlServerLinkedSchema } from "@/lib/database/sqlServerLinkedServers";
import { useFavoritesStore } from "@/stores/favoritesStore";
import type { ConnectionConfig, QueryTab } from "@/types/database";
import type { TableFavorite } from "@/types/favorites";

vi.mock("@/lib/backend/api", () => ({ listTableFavorites: vi.fn().mockResolvedValue({ items: [] }) }));
const config = { id: "c", db_type: "postgres" } as ConnectionConfig;
const t = (key: string) => key;
function tab(): QueryTab {
  return { id: "right-clicked", title: "Custom title", customTitle: true, mode: "data", connectionId: "c", database: "db", schema: "public", catalog: "catalog", sql: "", tableMeta: { tableName: "users", tableType: "TABLE", columns: [], primaryKeys: [] } } as QueryTab;
}

describe("table tab favorite menu", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("captures the clicked table identity, matching the sidebar rather than the title", () => {
    const clicked = tab();
    const store = useFavoritesStore();
    const add = vi.spyOn(store, "addTarget").mockResolvedValue(undefined);
    const menu = tableTabFavoriteMenuItems(clicked, config, t);
    clicked.tableMeta!.tableName = "later_table";
    menu[0].action?.();
    expect(add).toHaveBeenCalledWith(favoriteTargetFromNode({ id: "sidebar", type: "table", label: "users", connectionId: "c", database: "db", schema: "public", catalog: "catalog" }, config));
  });

  it("prefers explicit metadata and preserves empty namespaces", () => {
    const clicked = tab();
    Object.assign(clicked.tableMeta!, { database: "", schema: "", catalog: "" });
    const add = vi.spyOn(useFavoritesStore(), "addTarget").mockResolvedValue(undefined);
    tableTabFavoriteMenuItems(clicked, config, t)[0].action?.();
    expect(add).toHaveBeenCalledWith({ connectionId: "c", database: "", schema: "", catalog: "", objectName: "users", objectType: "table" });
  });

  it.each(["query", "structure", "mongo"] as const)("excludes %s tabs even with table metadata", (mode) => {
    expect(tableTabFavoriteMenuItems({ ...tab(), mode }, config, t)).toEqual([]);
  });

  it.each([undefined, "", "VIEW", "MATERIALIZED VIEW", "SEQUENCE", "SYNONYM"])("excludes unknown or non-table type %s", (tableType) => {
    const clicked = tab();
    clicked.tableMeta!.tableType = tableType;
    expect(tableTabFavoriteMenuItems(clicked, config, t)).toEqual([]);
  });

  it("does not infer missing metadata or names from titles", () => {
    expect(tableTabFavoriteMenuItems({ ...tab(), tableMeta: undefined }, config, t)).toEqual([]);
    const clicked = tab();
    clicked.tableMeta!.tableName = "";
    expect(tableTabFavoriteMenuItems(clicked, config, t)).toEqual([]);
  });

  it("offers an entry once real metadata becomes available, including MySQL base tables", () => {
    const clicked = tab();
    const metadata = clicked.tableMeta!;
    clicked.tableMeta = undefined;
    const mysql = { ...config, db_type: "mysql" } as ConnectionConfig;
    expect(tableTabFavoriteMenuItems(clicked, mysql, t)).toEqual([]);
    clicked.tableMeta = { ...metadata, tableType: "BASE TABLE" };
    expect(tableTabFavoriteMenuItems(clicked, mysql, t).map((entry) => entry.label)).toEqual(["favorites.add"]);
  });

  it("reuses connection, engine and linked-server exclusions", () => {
    expect(tableTabFavoriteMenuItems(tab(), undefined, t)).toEqual([]);
    expect(tableTabFavoriteMenuItems(tab(), { ...config, db_type: "mongodb" }, t)).toEqual([]);
    const clicked = tab();
    clicked.tableMeta!.schema = encodeSqlServerLinkedSchema({ server: "remote", catalog: "db", schema: "dbo" });
    expect(tableTabFavoriteMenuItems(clicked, { ...config, db_type: "sqlserver" }, t)).toEqual([]);
  });

  it("shares existing edit, remove and relink behavior", () => {
    const store = useFavoritesStore();
    const item = { id: "f", code: "F0001", name: "Users", revision: 1, connectionId: "c", database: "db", schema: "public", catalog: "catalog", objectType: "table", objectName: "users" } as TableFavorite;
    store.items = [item];
    const menu = tableTabFavoriteMenuItems(tab(), config, t);
    expect(menu.map((entry) => entry.label)).toEqual(["favorites.edit", "favorites.remove"]);
    menu[1].action?.();
    expect(store.dialog).toEqual({ mode: "edit", item, remove: true });
    store.relinking = item;
    const target = tab();
    target.tableMeta!.tableName = "new_users";
    tableTabFavoriteMenuItems(target, config, t)[0].action?.();
    expect(store.dialog).toEqual({ mode: "relink", item, target: expect.objectContaining({ objectName: "new_users" }) });
    for (const field of ["database", "schema", "catalog"] as const) {
      const other = tab();
      other[field] = "other";
      expect(tableTabFavoriteMenuItems(other, config, t).map((entry) => entry.label)).toContain("favorites.add");
    }
    const other = tab();
    other.connectionId = "other";
    expect(tableTabFavoriteMenuItems(other, { ...config, id: "other" }, t).map((entry) => entry.label)).toContain("favorites.add");
  });
});
