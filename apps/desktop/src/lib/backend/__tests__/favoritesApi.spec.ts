import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TableFavorite } from "@/types/favorites";
import { favoriteErrorMessage } from "@/lib/favorites/errors";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const item: TableFavorite = { id: "id / special", code: "F0001", name: "Customers", connectionId: "c", database: "db", schema: "public", catalog: "", objectType: "table", objectName: "customers", revision: 2, createdAt: 1, updatedAt: 2 };
const target = { connectionId: item.connectionId, database: item.database, schema: item.schema, catalog: item.catalog, objectType: item.objectType, objectName: item.objectName };
describe("favorites dual-backend contract", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => vi.unstubAllGlobals());
  it("forwards camelCase DTO and revision through all Tauri commands", async () => {
    const api = await import("@/lib/backend/tauri");
    mocks.invoke.mockResolvedValue(item);
    await api.listTableFavorites();
    await api.createTableFavorite({ target, name: item.name });
    await api.updateTableFavorite(item.id, { name: item.name, code: item.code, expectedRevision: 2 });
    await api.relinkTableFavorite(item.id, { target, expectedRevision: 2 });
    await api.removeTableFavorite(item.id, 2);
    expect(mocks.invoke.mock.calls).toEqual([
      ["list_table_favorites", undefined],
      ["create_table_favorite", { input: { target, name: item.name } }],
      ["update_table_favorite", { id: item.id, input: { name: item.name, code: item.code, expectedRevision: 2 } }],
      ["relink_table_favorite", { id: item.id, input: { target, expectedRevision: 2 } }],
      ["remove_table_favorite", { id: item.id, expectedRevision: 2 }],
    ]);
  });
  it("uses the authenticated HTTP namespace, encoded IDs and PATCH bodies", async () => {
    const api = await import("@/lib/backend/http");
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(item), { status: 200 })));
    vi.stubGlobal("fetch", fetch);
    await api.listTableFavorites();
    await api.createTableFavorite({ target, name: item.name });
    await api.updateTableFavorite(item.id, { name: item.name, code: item.code, expectedRevision: 2 });
    await api.relinkTableFavorite(item.id, { target, expectedRevision: 2 });
    expect(fetch.mock.calls[0][0]).toBe("/api/favorites/tables");
    expect(fetch.mock.calls[1][1].method).toBe("POST");
    expect(fetch.mock.calls[2][0]).toBe("/api/favorites/tables/id%20%2F%20special");
    expect(fetch.mock.calls[2][1].method).toBe("PATCH");
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ name: item.name, code: item.code, expectedRevision: 2 });
    expect(fetch.mock.calls[3][0]).toBe("/api/favorites/tables/id%20%2F%20special/target");
  });
  it("accepts an empty 204 delete response without trying to parse JSON", async () => {
    const api = await import("@/lib/backend/http");
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await expect(api.removeTableFavorite(item.id, 2)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("/api/favorites/tables/id%20%2F%20special?expectedRevision=2", { method: "DELETE" });
  });
  it("preserves the same conflict category for HTTP and Tauri errors", async () => {
    const api = await import("@/lib/backend/http");
    const detail = "FAVORITE_REVISION_CONFLICT: changed";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: 1, code: "DBX-LEGACY-0001", messageKey: "backendErrors.legacy", messageParams: {}, source: "legacyBackend", operationOutcome: "unknown", detail }), { status: 409 })));
    const reason = await api.updateTableFavorite(item.id, { name: item.name, code: item.code, expectedRevision: 1 }).catch((error: unknown) => error);
    expect(favoriteErrorMessage(reason, (key) => key)).toBe("favorites.revisionConflict");
    expect(favoriteErrorMessage(detail, (key) => key)).toBe("favorites.revisionConflict");
  });
});
