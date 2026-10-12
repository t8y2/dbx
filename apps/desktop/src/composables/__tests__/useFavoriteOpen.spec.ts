import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFavoriteOpen } from "../useFavoriteOpen";
import type { TableFavorite, FavoriteTarget } from "@/types/favorites";
import type { QueryTab } from "@/types/database";
const mocks = vi.hoisted(() => ({ getConfig: vi.fn(), ensureConnected: vi.fn(), openData: vi.fn(), queries: { tabs: [] as QueryTab[], activeTabId: "tab" } }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => mocks }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => mocks.queries }));
vi.mock("@/composables/useSidebarDataOpenRuntime", () => ({ useSidebarDataOpenRuntime: () => ({ openData: mocks.openData }) }));
const target: FavoriteTarget = { connectionId: "c", database: "db", schema: "public", catalog: "", objectType: "table", objectName: "users" };
const item: TableFavorite = { ...target, id: "f", code: "F0001", name: "NOT A SQL TABLE NAME", revision: 1, createdAt: 1, updatedAt: 1 };
describe("open favorite", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.queries.tabs = [];
    mocks.getConfig.mockReturnValue({ id: "c", db_type: "postgres" });
  });
  it("connects and calls existing openData using the actual name and no reuse override", async () => {
    await useFavoriteOpen().open(item);
    expect(mocks.ensureConnected).toHaveBeenCalledWith("c");
    expect(mocks.openData).toHaveBeenCalledWith(expect.objectContaining({ label: "users", schema: "public", database: "db" }));
    expect(mocks.openData.mock.calls[0]).toHaveLength(1);
  });
  it("reports missing connections before dispatch", async () => {
    mocks.getConfig.mockReturnValue(undefined);
    await expect(useFavoriteOpen().open(item)).rejects.toThrow("CONNECTION_NOT_FOUND");
    expect(mocks.openData).not.toHaveBeenCalled();
  });
  it("preserves connection errors instead of calling them missing tables", async () => {
    mocks.ensureConnected.mockRejectedValueOnce(new Error("permission denied"));
    await expect(useFavoriteOpen().open(item)).rejects.toThrow("permission denied");
    expect(mocks.openData).not.toHaveBeenCalled();
  });
  it("surfaces failures reported inside the existing data tab", async () => {
    mocks.queries.tabs = [{ id: "tab", mode: "data", connectionId: "c", database: "db", schema: "public", title: "users", result: { execution_error: true, rows: [["relation does not exist"]] } } as QueryTab];
    await expect(useFavoriteOpen().open(item)).rejects.toThrow("relation does not exist");
  });
  it("does not report failures from an unrelated active tab", async () => {
    mocks.queries.tabs = [{ id: "tab", mode: "data", connectionId: "other", database: "db", schema: "public", title: "users", result: { execution_error: true, rows: [["unrelated"]] } } as QueryTab];
    await expect(useFavoriteOpen().open(item)).resolves.toBeUndefined();
  });
});
