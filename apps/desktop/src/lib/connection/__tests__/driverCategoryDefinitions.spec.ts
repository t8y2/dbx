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
    expect(getCategoryForAgentDriver("access")).toBe("lightweight");
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
});

describe("prestosql special case", () => {
  it("is mapped to lightweight", () => {
    const category = getCategoryForAgentDriver("prestosql");

    expect(category).toBe("lightweight");
  });
});
