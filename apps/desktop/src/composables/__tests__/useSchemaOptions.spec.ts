import { describe, expect, it, vi } from "vitest";
import { schemaOptionsCacheKey, schemaOptionsForConnection, useSchemaOptions } from "@/composables/useSchemaOptions";
import type { ConnectionConfig } from "@/types/database";
const store = vi.hoisted(() => {
  const readSchemas = vi.fn();
  return { config: undefined as Partial<ConnectionConfig> | undefined, ensureConnected: vi.fn(), listCompletionSchemas: readSchemas, listNavigationSchemaChoices: readSchemas };
});
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ ...store, getConfig: () => store.config }) }));

describe("schemaOptionsForConnection", () => {
  it("sorts schema names with numeric suffixes naturally", () => {
    const schemaNames = ["WMWMSE16", "WMWMSE17", "WMWMSE18", "WMWMSE19", "WMWMSE2", "WMWMSE20", "WMWMSE1", "WMWMSE10"];

    expect(schemaOptionsForConnection(schemaNames, undefined)).toEqual(["WMWMSE1", "WMWMSE2", "WMWMSE10", "WMWMSE16", "WMWMSE17", "WMWMSE18", "WMWMSE19", "WMWMSE20"]);
    expect(schemaNames).toEqual(["WMWMSE16", "WMWMSE17", "WMWMSE18", "WMWMSE19", "WMWMSE2", "WMWMSE20", "WMWMSE1", "WMWMSE10"]);
  });

  it("sorts after applying the visible schema filter", () => {
    const connection = {
      db_type: "oracle" as const,
      visible_schemas: {
        ORCL: ["WMWMSE10", "WMWMSE2"],
      },
    };

    expect(schemaOptionsForConnection(["WMWMSE10", "SYSTEM", "WMWMSE2", "WMWMSE1"], connection, "ORCL")).toEqual(["WMWMSE2", "WMWMSE10"]);
  });

  it.each(["opengauss", "kingbase"] as const)("includes system schemas for %s when enabled", (dbType) => {
    expect(
      schemaOptionsForConnection(["information_schema", "pg_catalog", "public"], {
        db_type: dbType,
        show_system_schemas: true,
      }),
    ).toEqual(["information_schema", "pg_catalog", "public"]);
  });
});

describe("schemaOptionsCacheKey", () => {
  it("separates hidden and visible system-schema results", () => {
    expect(schemaOptionsCacheKey("connection-1", "postgres", false)).not.toBe(schemaOptionsCacheKey("connection-1", "postgres", true));
  });
});

describe("live schema options", () => {
  it("refreshes shared candidates when a newly selected schema was not cached, without looping on unavailable names", async () => {
    store.config = { db_type: "postgres", visible_schemas: { orders: ["public"] } };
    store.listNavigationSchemaChoices.mockResolvedValueOnce(["public"]).mockResolvedValue(["public", "new_app"]);
    const options = useSchemaOptions();
    await options.loadSchemaOptions("c", "orders");
    store.config = { ...store.config, visible_schemas: { orders: ["new_app", "unavailable"] } };
    await options.loadSchemaOptions("c", "orders");
    expect(store.listNavigationSchemaChoices).toHaveBeenLastCalledWith("c", "orders", true, true);
    expect(options.getSchemaOptionsForDb("c", "orders")).toEqual(["new_app"]);
    store.listNavigationSchemaChoices.mockClear();
    await options.loadSchemaOptions("c", "orders");
    expect(store.listNavigationSchemaChoices).not.toHaveBeenCalled();
  });
  it("loads complete candidates before a legacy hidden-system scope becomes an explicit system selection", async () => {
    store.config = { db_type: "postgres", show_system_schemas: false };
    store.listCompletionSchemas.mockResolvedValueOnce(["public"]).mockResolvedValue(["public", "pg_catalog"]);
    const options = useSchemaOptions();
    await options.loadSchemaOptions("c", "orders");
    expect(store.listCompletionSchemas).toHaveBeenLastCalledWith("c", "orders");
    expect(options.getSchemaOptionsForDb("c", "orders")).toEqual(["public"]);
    store.config = { ...store.config, visible_schemas: { orders: ["pg_catalog"] } };
    await options.loadSchemaOptions("c", "orders");
    expect(options.getSchemaOptionsForDb("c", "orders")).toEqual(["pg_catalog"]);
  });
  it("filters raw cached names using the latest saved scope without reloading", async () => {
    store.config = { db_type: "postgres", visible_schemas: { orders: ["public"] } };
    store.listNavigationSchemaChoices.mockResolvedValue(["public", "sales", "pg_catalog"]);
    const options = useSchemaOptions();
    await options.loadSchemaOptions("c", "orders");
    expect(options.getSchemaOptionsForDb("c", "orders")).toEqual(["public"]);
    store.config = { ...store.config, visible_schemas: { orders: ["sales", "pg_catalog"] } };
    expect(options.getSchemaOptionsForDb("c", "orders")).toEqual(["pg_catalog", "sales"]);
    store.config = { ...store.config, visible_schemas: { orders: [] } };
    expect(options.getSchemaOptionsForDb("c", "orders")).toEqual([]);
  });
  it("does not reapply a stale filter when a schema request completes late", async () => {
    store.config = { db_type: "postgres", visible_schemas: { orders: ["public"] } };
    let complete!: (names: string[]) => void;
    store.listNavigationSchemaChoices.mockReturnValue(new Promise<string[]>((resolve) => (complete = resolve)));
    const options = useSchemaOptions();
    const pending = options.loadSchemaOptions("c", "orders");
    await Promise.resolve();
    store.config = { ...store.config, visible_schemas: { orders: ["sales"] } };
    complete(["public", "sales"]);
    await pending;
    expect(options.getSchemaOptionsForDb("c", "orders")).toEqual(["sales"]);
  });
});
