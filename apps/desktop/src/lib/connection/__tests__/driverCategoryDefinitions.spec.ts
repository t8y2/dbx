import { describe, expect, it } from "vitest";
import { AGENT_DRIVER_CATEGORY_MAP, DRIVER_CATEGORIES, assertAgentDriverCategoriesComplete, getCategoryForAgentDriver } from "@/lib/connection/driver-category-definitions";
import { MANAGED_JDBC_DRIVERS } from "@/lib/database/managedJdbcDrivers";
import { databaseManifestEntry, manifestDatabaseTypes } from "@/lib/database/databaseDriverManifest";

describe("getCategoryForAgentDriver", () => {
  it("returns correct category for one key from each of the 9 categories", () => {
    // sql
    expect(getCategoryForAgentDriver("oracle")).toBe("sql");
    // analytics
    expect(getCategoryForAgentDriver("snowflake")).toBe("analytics");
    // domestic
    expect(getCategoryForAgentDriver("dameng")).toBe("domestic");
    // lightweight
    expect(getCategoryForAgentDriver("duckdb")).toBe("lightweight");
    // document
    expect(getCategoryForAgentDriver("mongodb")).toBe("document");
    // graph_ai
    expect(getCategoryForAgentDriver("neo4j")).toBe("graph_ai");
    // timeseries
    expect(getCategoryForAgentDriver("tdengine")).toBe("timeseries");
    // mq
    expect(getCategoryForAgentDriver("kafka")).toBe("mq");
    // registry_config
    expect(getCategoryForAgentDriver("etcd")).toBe("registry_config");
  });

  it('returns "all" for unknown keys', () => {
    expect(getCategoryForAgentDriver("")).toBe("all");
    expect(getCategoryForAgentDriver("unknown_driver_xyz")).toBe("all");
    expect(getCategoryForAgentDriver("nosuchdriver")).toBe("all");
    expect(getCategoryForAgentDriver("random-string-123")).toBe("all");
  });
});

describe("assertAgentDriverCategoriesComplete", () => {
  it("does not throw when all keys mapped", () => {
    const mappedKeys = Object.keys(AGENT_DRIVER_CATEGORY_MAP);

    expect(() => assertAgentDriverCategoriesComplete(mappedKeys)).not.toThrow();
  });

  it("throws when a key is missing", () => {
    const mappedKeys = Object.keys(AGENT_DRIVER_CATEGORY_MAP);

    expect(() => assertAgentDriverCategoriesComplete([...mappedKeys, "no_such_driver"])).toThrow("unmapped=no_such_driver");
  });
});

describe("AGENT_DRIVER_CATEGORY_MAP integrity", () => {
  it("has no agent driver key mapped to more than one category (i.e. no duplicate keys)", () => {
    const entries = Object.entries(AGENT_DRIVER_CATEGORY_MAP);
    const keys = entries.map(([key]) => key);

    // Each key in a Record is already unique by definition, but verify
    // there are no unexpected dupes in the data.
    const seen = new Set<string>();
    for (const k of keys) {
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  it("has all category values listed in DRIVER_CATEGORIES", () => {
    const validCategoryKeys = new Set(DRIVER_CATEGORIES.map((c) => c.key));

    for (const [driverKey, category] of Object.entries(AGENT_DRIVER_CATEGORY_MAP)) {
      expect(validCategoryKeys.has(category), `Driver "${driverKey}" maps to unknown category "${category}"`).toBe(true);
    }
  });

  it("covers every driver the store can list, derived from the manifest", () => {
    // Derived, not hand-maintained: the driver store renders
    // `agent_catalog::driver_store_entries()` (the store-visible entries of
    // database-drivers.manifest.json) plus the built-in managed JDBC rows. A
    // hand-written list silently absorbs a missing key — `oracle-oci` shipped
    // store-visible with no category and only produced a console warning in dev.
    const expectedKeys = new Set<string>(manifestStoreVisibleAgentKeys());
    for (const definition of MANAGED_JDBC_DRIVERS) {
      expectedKeys.add(definition.id);
    }

    const actualKeys = new Set(Object.keys(AGENT_DRIVER_CATEGORY_MAP));
    const missing = [...expectedKeys].filter((key) => !actualKeys.has(key));

    expect(missing, `Store-visible drivers without a category: ${missing.join(", ")}`).toEqual([]);
  });
});

/**
 * Mirrors `agent_catalog::driver_store_entries()`: the base agent key of every
 * store-visible entry, every store-visible profile (by `packageKey` when it
 * shares another module's package), and every store-visible managed driver.
 */
function manifestStoreVisibleAgentKeys(): string[] {
  const keys: string[] = [];
  for (const dbType of manifestDatabaseTypes()) {
    const entry = databaseManifestEntry(dbType);
    if (!entry) continue;
    if (entry.driverStoreVisible && entry.agentKey) {
      keys.push(entry.agentKey);
    }
    for (const profile of entry.driverProfiles ?? []) {
      if (profile.storeVisible) {
        keys.push(profile.packageKey ?? profile.agentKey);
      }
    }
    for (const driver of entry.managedDrivers ?? []) {
      if (driver.storeVisible) {
        keys.push(driver.key);
      }
    }
  }
  return [...new Set(keys)];
}

describe("built-in JDBC drivers match ConnectionDialog categories", () => {
  it("maps PrestoSQL and Apache Phoenix to analytics", () => {
    expect(getCategoryForAgentDriver("prestosql")).toBe("analytics");
    expect(getCategoryForAgentDriver("phoenix")).toBe("analytics");
  });
});

describe("Oracle OCI driver category", () => {
  it("groups the OCI (thick) agent with the thin driver under SQL", () => {
    expect(getCategoryForAgentDriver("oracle-oci")).toBe("sql");
  });
});
