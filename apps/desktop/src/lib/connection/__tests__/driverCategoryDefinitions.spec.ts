import { describe, expect, it } from "vitest";
import { AGENT_DRIVER_CATEGORY_MAP, DRIVER_CATEGORIES, assertAgentDriverCategoriesComplete, getCategoryForAgentDriver } from "@/lib/connection/driver-category-definitions";

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

  it("covers all known agent driver keys with no stale entries", () => {
    // Golden set — mirrors the store-visible entries in agent_catalog.rs
    // plus EXTRA_DRIVER_STORE_ENTRIES (duckdb, kafka, rocketmq,
    // rabbitmq, sqlserver-legacy) and the PrestoSQL built-in driver.
    // When an Agent driver is added to the catalog its key MUST appear here;
    // removing a key from the map without removing it from the list below
    // will fail this test.
    const expectedKeys = new Set([
      // sql
      "db2",
      "firebird",
      "informix",
      "iris",
      "oracle",
      "sqlserver-legacy",
      // analytics
      "bigquery",
      "databend",
      "databricks",
      "exasol",
      "hive",
      "kylin",
      "prestosql",
      "saphana",
      "snowflake",
      "spark",
      "teradata",
      "trino",
      "vertica",
      // domestic
      "dameng",
      "gbase8a",
      "gbase8s",
      "goldendb",
      "highgo",
      "kingbase",
      "oceanbase-oracle",
      "oscar",
      "sundb",
      "uxdb",
      "vastbase",
      "xugu",
      "yashandb",
      // lightweight
      "access",
      "duckdb",
      "h2",
      "h2-legacy",
      // document
      "cassandra",
      "mongodb",
      // graph_ai
      "neo4j",
      // timeseries
      "influxdb",
      "iotdb",
      "tdengine",
      // mq
      "kafka",
      "rabbitmq",
      "rocketmq",
      // registry_config
      "etcd",
      "zookeeper",
    ]);
    const actualKeys = Object.keys(AGENT_DRIVER_CATEGORY_MAP);

    expect(actualKeys).toHaveLength(expectedKeys.size);

    const actualSet = new Set(actualKeys);
    const missing = [...expectedKeys].filter((k) => !actualSet.has(k));
    const extra = actualKeys.filter((k) => !expectedKeys.has(k));

    expect(missing, `Missing from AGENT_DRIVER_CATEGORY_MAP: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `Extra keys in AGENT_DRIVER_CATEGORY_MAP not in expected set: ${extra.join(", ")}`).toEqual([]);
  });
});

describe("prestosql matches ConnectionDialog category", () => {
  it("is mapped to analytics (same as ConnectionDialog dbCategoryDefinitions)", () => {
    expect(getCategoryForAgentDriver("prestosql")).toBe("analytics");
  });
});
