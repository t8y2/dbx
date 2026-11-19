import { describe, expect, it } from "vitest";
import { selectStableDrivers, selectUpdatableDrivers, hasAnyUpdatableDriverMatching, selectDriversByInstallStatus, countInstalledDrivers, countAvailableDrivers, partitionDriversByInstallStatus, upgradeAllDriverTypes, upgradeAllMatchesFullUpdateSet } from "@/lib/connection/driverListFilter";
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

describe("selectDriversByInstallStatus", () => {
  const mysql = driver({ db_type: "mysql", installed: true });
  const postgres = driver({ db_type: "postgres", installed: false });
  const sqlite = driver({ db_type: "sqlite", installed: true, update_available: true });

  it("returns a copy of all drivers for 'all'", () => {
    const drivers = [mysql, postgres, sqlite];
    const result = selectDriversByInstallStatus(drivers, "all");
    expect(result.map((d) => d.db_type)).toEqual(["mysql", "postgres", "sqlite"]);
    expect(result).not.toBe(drivers);
  });

  it("returns only installed drivers, including those with updates", () => {
    expect(selectDriversByInstallStatus([mysql, postgres, sqlite], "installed").map((d) => d.db_type)).toEqual(["mysql", "sqlite"]);
  });

  it("returns only drivers that are not installed", () => {
    expect(selectDriversByInstallStatus([mysql, postgres, sqlite], "available").map((d) => d.db_type)).toEqual(["postgres"]);
  });

  it("returns empty arrays when nothing matches", () => {
    expect(selectDriversByInstallStatus([postgres], "installed")).toEqual([]);
    expect(selectDriversByInstallStatus([mysql], "available")).toEqual([]);
    expect(selectDriversByInstallStatus([], "all")).toEqual([]);
  });
});

describe("install-status counts", () => {
  it("counts installed and available drivers without double-counting updates", () => {
    const drivers = [driver({ db_type: "mysql", installed: true }), driver({ db_type: "postgres", installed: false }), driver({ db_type: "sqlite", installed: true, update_available: true })];
    expect(countInstalledDrivers(drivers)).toBe(2);
    expect(countAvailableDrivers(drivers)).toBe(1);
  });

  it("returns zeros for an empty list", () => {
    expect(countInstalledDrivers([])).toBe(0);
    expect(countAvailableDrivers([])).toBe(0);
  });
});

describe("partitionDriversByInstallStatus", () => {
  const mysql = driver({ db_type: "mysql", installed: true, update_available: false });
  const postgres = driver({ db_type: "postgres", installed: false, update_available: false });
  const sqlite = driver({ db_type: "sqlite", installed: true, update_available: true });
  // Stale registry / missing jar: not installed, but update_available is true.
  const staleOracle = driver({ db_type: "oracle", installed: false, update_available: true });

  it("keeps uninstalled update_available drivers in the available list and hides the banner", () => {
    const { updatable, stable } = partitionDriversByInstallStatus([mysql, postgres, sqlite, staleOracle], "available");

    expect(updatable).toEqual([]);
    expect(stable.map((d) => d.db_type)).toEqual(["postgres", "oracle"]);
  });

  it("does not put uninstalled update_available drivers in the installed banner", () => {
    const { updatable, stable } = partitionDriversByInstallStatus([mysql, postgres, sqlite, staleOracle], "installed");

    expect(updatable.map((d) => d.db_type)).toEqual(["sqlite"]);
    expect(stable.map((d) => d.db_type)).toEqual(["mysql"]);
  });

  it("keeps the all-status partition aligned with updatable vs stable", () => {
    const drivers = [mysql, postgres, sqlite, staleOracle];
    const { updatable, stable } = partitionDriversByInstallStatus(drivers, "all");

    expect(updatable.map((d) => d.db_type)).toEqual(["sqlite", "oracle"]);
    expect(stable.map((d) => d.db_type)).toEqual(["mysql", "postgres"]);
    expect(updatable.length + stable.length).toBe(drivers.length);
  });

  it("returns empty sides when the status filter matches nothing", () => {
    expect(partitionDriversByInstallStatus([postgres], "installed")).toEqual({ updatable: [], stable: [] });
    expect(partitionDriversByInstallStatus([mysql], "available")).toEqual({ updatable: [], stable: [] });
  });

  it("does not copy the naive available composition that drops stale updatables", () => {
    expect(selectStableDrivers(selectDriversByInstallStatus([staleOracle], "available"))).toEqual([]);
    expect(partitionDriversByInstallStatus([staleOracle], "available").stable.map((d) => d.db_type)).toEqual(["oracle"]);
  });

  it("installed banner+list cover every installed driver exactly once", () => {
    const drivers = [mysql, postgres, sqlite, staleOracle];
    const { updatable, stable } = partitionDriversByInstallStatus(drivers, "installed");
    expect(updatable.length + stable.length).toBe(countInstalledDrivers(drivers));
  });

  it("available list covers every uninstalled driver exactly once", () => {
    const drivers = [mysql, postgres, sqlite, staleOracle];
    const { updatable, stable } = partitionDriversByInstallStatus(drivers, "available");
    expect(updatable).toEqual([]);
    expect(stable.length).toBe(countAvailableDrivers(drivers));
  });

  it("Upgrade All keys match the visible banner, not hidden stale uninstalled rows", () => {
    const drivers = [mysql, postgres, sqlite, staleOracle];
    expect(upgradeAllDriverTypes(drivers, "installed")).toEqual(["sqlite"]);
    expect(upgradeAllMatchesFullUpdateSet(drivers, "installed")).toBe(false);
    expect(upgradeAllDriverTypes(drivers, "all")).toEqual(["sqlite", "oracle"]);
    expect(upgradeAllMatchesFullUpdateSet(drivers, "all")).toBe(true);
    expect(upgradeAllDriverTypes(drivers, "available")).toEqual([]);
    expect(upgradeAllMatchesFullUpdateSet(drivers, "available")).toBe(false);
  });

  it("allows the batch Upgrade All button when every updatable is visible", () => {
    expect(upgradeAllMatchesFullUpdateSet([sqlite], "installed")).toBe(true);
    expect(upgradeAllDriverTypes([sqlite], "installed")).toEqual(["sqlite"]);
  });

  it("does not treat equal-sized but different updatable sets as a safe batch", () => {
    const installedOther = driver({ db_type: "mysql", installed: true, update_available: false });
    const visibleInstalled = driver({ db_type: "sqlite", installed: true, update_available: true });
    const hiddenStale = driver({ db_type: "oracle", installed: false, update_available: true });
    expect(upgradeAllDriverTypes([installedOther, visibleInstalled, hiddenStale], "installed")).toEqual(["sqlite"]);
    expect(upgradeAllMatchesFullUpdateSet([installedOther, visibleInstalled, hiddenStale], "installed")).toBe(false);
  });
});

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

// ---------------------------------------------------------------------------
// hasAnyUpdatableDriverMatching — regression tests for empty‑state suppression
// (DriverStoreDialog.vue)
// ---------------------------------------------------------------------------

/** Simple matchers mirroring the component's real predicates. */
function labelSearch(d: AgentDriverInfo, q: string) {
  return d.label.toLowerCase().includes(q);
}
function categoryOf(d: AgentDriverInfo) {
  // Map db_type prefixes to categories — the real mapping lives in
  // getCategoryForAgentDriver; this simplified version is sufficient for tests.
  if (d.db_type === "neo4j") return "graph";
  return "relational";
}

describe("hasAnyUpdatableDriverMatching", () => {
  const neo4j = driver({ db_type: "neo4j", label: "Neo4j", update_available: true });
  const oracle = driver({ db_type: "oracle", label: "Oracle", update_available: true });

  it("returns false when there are no updatable drivers", () => {
    expect(
      hasAnyUpdatableDriverMatching([], {
        searchQuery: "",
        selectedCategory: "all",
        driverMatchesSearch: labelSearch,
        driverCategory: categoryOf,
      }),
    ).toBe(false);
  });

  it("returns true for 'all' category with no search when updatable drivers exist", () => {
    expect(
      hasAnyUpdatableDriverMatching([neo4j], {
        searchQuery: "",
        selectedCategory: "all",
        driverMatchesSearch: labelSearch,
        driverCategory: categoryOf,
      }),
    ).toBe(true);
  });

  it("returns true when an updatable driver matches the search", () => {
    expect(
      hasAnyUpdatableDriverMatching([neo4j, oracle], {
        searchQuery: "neo4j",
        selectedCategory: "all",
        driverMatchesSearch: labelSearch,
        driverCategory: categoryOf,
      }),
    ).toBe(true);
  });

  it("returns false when no updatable driver matches the search (regression: search 'zzzz' with Neo4j update)", () => {
    expect(
      hasAnyUpdatableDriverMatching([neo4j], {
        searchQuery: "zzzz",
        selectedCategory: "all",
        driverMatchesSearch: labelSearch,
        driverCategory: categoryOf,
      }),
    ).toBe(false);
  });

  it("returns true when an updatable driver belongs to the selected category", () => {
    expect(
      hasAnyUpdatableDriverMatching([neo4j, oracle], {
        searchQuery: "",
        selectedCategory: "graph",
        driverMatchesSearch: labelSearch,
        driverCategory: categoryOf,
      }),
    ).toBe(true);
  });

  it("returns false when no updatable driver belongs to the selected category (regression: Neo4j update, 'relational' category)", () => {
    expect(
      hasAnyUpdatableDriverMatching([neo4j], {
        searchQuery: "",
        selectedCategory: "relational",
        driverMatchesSearch: labelSearch,
        driverCategory: categoryOf,
      }),
    ).toBe(false);
  });

  it("search takes precedence over category when both are active", () => {
    // Neo4j is in "graph" category; user selected "graph" but searched "oracle".
    expect(
      hasAnyUpdatableDriverMatching([neo4j, oracle], {
        searchQuery: "oracle",
        selectedCategory: "graph",
        driverMatchesSearch: labelSearch,
        driverCategory: categoryOf,
      }),
    ).toBe(true);
  });

  it("returns false when the install-status filter is 'available' (update banner is hidden)", () => {
    expect(
      hasAnyUpdatableDriverMatching([neo4j], {
        searchQuery: "",
        selectedCategory: "all",
        driverMatchesSearch: labelSearch,
        driverCategory: categoryOf,
        installStatus: "available",
      }),
    ).toBe(false);
  });

  it("still matches updatable drivers when the install-status filter is 'installed'", () => {
    expect(
      hasAnyUpdatableDriverMatching([neo4j], {
        searchQuery: "",
        selectedCategory: "all",
        driverMatchesSearch: labelSearch,
        driverCategory: categoryOf,
        installStatus: "installed",
      }),
    ).toBe(true);
  });
});
