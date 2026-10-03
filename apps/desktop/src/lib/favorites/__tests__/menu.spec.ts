import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { tableFavoriteMenuItems } from "../menu";
import { useFavoritesStore } from "@/stores/favoritesStore";
import type { ConnectionConfig, TreeNode } from "@/types/database";
import type { TableFavorite } from "@/types/favorites";
const mocks = vi.hoisted(() => ({ listTableFavorites: vi.fn() }));
vi.mock("@/lib/backend/api", () => mocks);
const node: TreeNode = { id: "tree", type: "table", connectionId: "c", database: "db", schema: "public", label: "users" };
const config = { id: "c", db_type: "postgres" } as ConnectionConfig;
describe("favorite menu integration", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.listTableFavorites.mockResolvedValue({ items: [] });
  });
  it("captures the chosen table rather than a later active tree node", async () => {
    const copy = { ...node };
    const menu = tableFavoriteMenuItems(copy, config, (key) => key);
    copy.label = "different";
    menu[0].action?.();
    await useFavoritesStore().refresh();
    await Promise.resolve();
    expect(useFavoritesStore().dialog).toEqual({ mode: "create", target: expect.objectContaining({ objectName: "users" }) });
  });
  it("offers relink confirmation while preserving favorite identity", () => {
    const store = useFavoritesStore();
    const item = { id: "f", name: "Old", revision: 2 } as TableFavorite;
    store.relinking = item;
    const menu = tableFavoriteMenuItems(node, config, (key) => key);
    menu[0].action?.();
    expect(store.dialog).toEqual({ mode: "relink", item, target: expect.objectContaining({ objectName: "users" }) });
  });
  it("adds no menu items for non-table nodes", () => {
    expect(tableFavoriteMenuItems({ ...node, type: "view" }, config, (key) => key)).toEqual([]);
  });
});
