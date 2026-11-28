// @vitest-environment happy-dom

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EDITOR_SETTINGS, useSettingsStore } from "../settingsStore";

const backend = vi.hoisted(() => ({
  loadEditorSettings: vi.fn(),
  saveEditorSettings: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => backend);

describe("settingsStore virtual foreign keys", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    if (typeof globalThis.localStorage?.clear === "function") {
      globalThis.localStorage.clear();
    }
    setActivePinia(createPinia());
    backend.loadEditorSettings.mockResolvedValue({ ...DEFAULT_EDITOR_SETTINGS });
    backend.saveEditorSettings.mockResolvedValue(undefined);
  });

  it("upserts, imports, removes, and clears virtual foreign keys per connection", async () => {
    const store = useSettingsStore();
    await store.initEditorSettings();

    store.upsertVirtualForeignKey({
      connectionId: "conn-1",
      source: { database: "shop", schema: "public", table: "orders", column: "customer_id" },
      target: { database: "shop", schema: "public", table: "customers", column: "id" },
      bidirectional: false,
    });

    expect(store.editorSettings.virtualForeignKeys).toHaveLength(1);
    const createdId = store.editorSettings.virtualForeignKeys[0]!.id;

    const imported = store.importVirtualForeignKeys("conn-1", [
      {
        source: { database: "shop", schema: "public", table: "customers", column: "id" },
        target: { database: "shop", schema: "public", table: "orders", column: "customer_id" },
        bidirectional: false,
      },
      {
        source: { database: "shop", schema: "public", table: "invoices", column: "customer_id" },
        target: { database: "shop", schema: "public", table: "customers", column: "id" },
        bidirectional: true,
      },
    ]);

    expect(imported.added).toBe(1);
    expect(imported.upgraded).toBe(1);
    expect(store.editorSettings.virtualForeignKeys).toHaveLength(2);
    expect(store.editorSettings.virtualForeignKeys[0]?.bidirectional).toBe(true);

    store.upsertVirtualForeignKey({
      connectionId: "conn-2",
      source: { database: "crm", table: "tickets", column: "owner_id" },
      target: { database: "crm", table: "agents", column: "id" },
      bidirectional: true,
    });
    expect(store.editorSettings.virtualForeignKeys).toHaveLength(3);

    store.removeVirtualForeignKey(createdId);
    expect(store.editorSettings.virtualForeignKeys).toHaveLength(2);

    store.clearVirtualForeignKeysForConnection("conn-1");
    expect(store.editorSettings.virtualForeignKeys).toHaveLength(1);
    expect(store.editorSettings.virtualForeignKeys[0]?.connectionId).toBe("conn-2");
  });
});
