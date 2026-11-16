import { beforeEach, describe, expect, it, vi } from "vitest";
import { schemaOptionsCacheKey, schemaOptionsForConnection, useSchemaOptions } from "@/composables/useSchemaOptions";
import { invalidateSchemaOptionsCache, schemaOptionsByKey } from "@/lib/database/schemaOptionsCache";

const listSchemas = vi.hoisted(() => vi.fn());

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => ({ db_type: "postgres" }),
    ensureConnected: async () => undefined,
  }),
}));

vi.mock("@/lib/backend/api", () => ({ listSchemas }));

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

describe("invalidateSchemaOptionsCache (#14582)", () => {
  beforeEach(() => {
    schemaOptionsByKey.value = {};
  });

  it("drops both system-schema variants of one database and keeps the neighbours", () => {
    const showSystem = schemaOptionsCacheKey("c1", "app", true);
    const hideSystem = schemaOptionsCacheKey("c1", "app", false);
    const otherDatabase = schemaOptionsCacheKey("c1", "archive", false);
    const otherConnection = schemaOptionsCacheKey("c2", "app", false);
    schemaOptionsByKey.value = { [showSystem]: ["public"], [hideSystem]: ["public"], [otherDatabase]: ["x"], [otherConnection]: ["y"] };

    invalidateSchemaOptionsCache("c1", "app");

    expect(schemaOptionsByKey.value[showSystem]).toBeUndefined();
    expect(schemaOptionsByKey.value[hideSystem]).toBeUndefined();
    expect(schemaOptionsByKey.value[otherDatabase]).toEqual(["x"]);
    expect(schemaOptionsByKey.value[otherConnection]).toEqual(["y"]);
  });

  it("drops every database of the connection when none is named", () => {
    schemaOptionsByKey.value = { [schemaOptionsCacheKey("c1", "app", false)]: ["a"], [schemaOptionsCacheKey("c1", "archive", false)]: ["b"], [schemaOptionsCacheKey("c2", "app", false)]: ["c"] };

    invalidateSchemaOptionsCache("c1");

    expect(Object.keys(schemaOptionsByKey.value)).toEqual([schemaOptionsCacheKey("c2", "app", false)]);
  });

  it("does not treat a longer connection id as the same connection", () => {
    const neighbour = schemaOptionsCacheKey("c10", "app", false);
    schemaOptionsByKey.value = { [schemaOptionsCacheKey("c1", "app", false)]: ["a"], [neighbour]: ["b"] };

    invalidateSchemaOptionsCache("c1");

    expect(schemaOptionsByKey.value[neighbour]).toEqual(["b"]);
  });
});

describe("useSchemaOptions sharing (#14582)", () => {
  beforeEach(() => {
    schemaOptionsByKey.value = {};
    listSchemas.mockReset();
  });

  it("shares one cache across pickers and re-reads it after invalidation", async () => {
    const toolbar = useSchemaOptions();
    const other = useSchemaOptions();

    listSchemas.mockResolvedValue(["public"]);
    await toolbar.loadSchemaOptions("c1", "app");
    expect(toolbar.getSchemaOptionsForDb("c1", "app")).toEqual(["public"]);

    // A second picker reuses the shared list instead of hitting the server again.
    await other.loadSchemaOptions("c1", "app");
    expect(listSchemas).toHaveBeenCalledTimes(1);
    expect(other.getSchemaOptionsForDb("c1", "app")).toEqual(["public"]);

    // After "the schemas changed", the next open re-reads and sees the new schema.
    listSchemas.mockResolvedValue(["public", "reporting"]);
    invalidateSchemaOptionsCache("c1", "app");
    await other.loadSchemaOptions("c1", "app");
    expect(listSchemas).toHaveBeenCalledTimes(2);
    expect(other.getSchemaOptionsForDb("c1", "app")).toEqual(["public", "reporting"]);
    expect(toolbar.getSchemaOptionsForDb("c1", "app")).toEqual(["public", "reporting"]);
  });
});
