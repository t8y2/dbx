import { describe, expect, it } from "vitest";
import { selectStableDrivers, selectUpdatableDrivers } from "@/lib/connection/driverListFilter";
import type { AgentDriverInfo } from "@/lib/backend/api";

function driver(overrides: Partial<AgentDriverInfo> = {}): AgentDriverInfo {
  return {
    db_type: "test",
    label: "Test",
    version: "1.0",
    size: 0,
    installed: true,
    installed_version: "1.0",
    update_available: false,
    jre: "",
    jre_installed: false,
    ...overrides,
  };
}

describe("selectUpdatableDrivers", () => {
  it("returns only drivers with update_available === true", () => {
    const drivers: AgentDriverInfo[] = [driver({ db_type: "mysql", update_available: true }), driver({ db_type: "postgres", update_available: false }), driver({ db_type: "sqlite", update_available: true })];

    const result = selectUpdatableDrivers(drivers);

    expect(result).toHaveLength(2);
    expect(result.map((d) => d.db_type)).toEqual(["mysql", "sqlite"]);
  });

  it("returns empty array when no drivers have updates available", () => {
    const drivers: AgentDriverInfo[] = [driver({ db_type: "mysql", update_available: false }), driver({ db_type: "postgres", update_available: false })];

    expect(selectUpdatableDrivers(drivers)).toEqual([]);
  });

  it("returns empty array for an empty input", () => {
    expect(selectUpdatableDrivers([])).toEqual([]);
  });
});

describe("selectStableDrivers", () => {
  it("returns only drivers with update_available === false", () => {
    const drivers: AgentDriverInfo[] = [driver({ db_type: "mysql", update_available: true }), driver({ db_type: "postgres", update_available: false }), driver({ db_type: "sqlite", update_available: false })];

    const result = selectStableDrivers(drivers);

    expect(result).toHaveLength(2);
    expect(result.map((d) => d.db_type)).toEqual(["postgres", "sqlite"]);
  });

  it("returns all drivers when none have updates", () => {
    const drivers: AgentDriverInfo[] = [driver({ db_type: "mysql", update_available: false }), driver({ db_type: "postgres", update_available: false })];

    expect(selectStableDrivers(drivers)).toHaveLength(2);
  });

  it("returns empty array when all drivers have updates", () => {
    const drivers: AgentDriverInfo[] = [driver({ db_type: "mysql", update_available: true }), driver({ db_type: "sqlite", update_available: true })];

    expect(selectStableDrivers(drivers)).toEqual([]);
  });
});

describe("partition invariant", () => {
  it("updatable + stable drivers cover the full input with no overlap", () => {
    const drivers: AgentDriverInfo[] = [driver({ db_type: "mysql", update_available: true }), driver({ db_type: "postgres", update_available: false }), driver({ db_type: "sqlite", update_available: true }), driver({ db_type: "oracle", update_available: false })];

    const updatable = selectUpdatableDrivers(drivers);
    const stable = selectStableDrivers(drivers);

    // No duplicate db_types between the two sets.
    const updatableKeys = new Set(updatable.map((d) => d.db_type));
    for (const d of stable) {
      expect(updatableKeys.has(d.db_type)).toBe(false);
    }

    // Union is the full set.
    expect(updatable.length + stable.length).toBe(drivers.length);
  });
});

describe("search deduplication", () => {
  it("updatable drivers are excluded from stable so they only appear in the global update section", () => {
    const drivers: AgentDriverInfo[] = [driver({ db_type: "neo4j", label: "Neo4j", update_available: true }), driver({ db_type: "oracle", label: "Oracle", update_available: true }), driver({ db_type: "postgres", label: "PostgreSQL", update_available: false })];

    const stable = selectStableDrivers(drivers);

    // Searching for "Neo4j" in stable should produce no results — the driver
    // already appears in the global update section above and must not be
    // duplicated in the category-filtered search results below.
    const searchHit = stable.some((d) => d.db_type === "neo4j");
    expect(searchHit).toBe(false);
  });
});
