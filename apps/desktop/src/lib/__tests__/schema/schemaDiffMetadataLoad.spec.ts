import { describe, expect, it } from "vitest";
import {
  createConcurrencyLimiter,
  loadSchemaDetails,
  mapWithConcurrency,
  schemaDiffMetadataConcurrency,
  schemaDiffMetadataLaneCountForTests,
  schemaDiffMetadataLoadPlan,
  shouldFetchSchemaDiffDdl,
  type SchemaDiffMetadataApi,
  type SchemaDiffMetadataProgress,
} from "../../schema/schemaDiffMetadataLoad";
import { getSchemaDiffNextProgressStep, shouldLoadSchemaDiffExtraObjectPhase, shouldLoadSchemaDiffExtraObjects, shouldLoadSchemaDiffRoutines } from "../../schema/schemaDiffProgress";
import { DEFAULT_MYSQL_OPTIONS, DEFAULT_POSTGRES_OPTIONS } from "../../../types/schemaDiff";
import type { TableInfo } from "../../../types/database";

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const METADATA_POOL_BUSY = "DBX metadata pool is busy; please retry";

/**
 * Mirrors the backend metadata gate (`crates/dbx-core/src/connection/mod.rs`):
 * at most `capacity` in-flight metadata requests per gate key, and any request
 * that cannot start is what `METADATA_POOL_ACQUIRE_TIMEOUT` (5s) reports as
 * `DBX metadata pool is busy; please retry`.
 *
 * The fake rejects waiting requests instead of modelling the 5s wait, which is
 * the conservative side of the real timeout: a test that passes here proves the
 * caller never queues on the gate at all, not merely that it waits less than
 * five seconds.
 */
function createMetadataGate(capacity: number) {
  const active = new Map<string, number>();
  let peak = 0;

  return {
    peak: () => peak,
    async run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const current = active.get(key) ?? 0;
      if (current >= capacity) throw new Error(METADATA_POOL_BUSY);
      active.set(key, current + 1);
      peak = Math.max(peak, current + 1);
      try {
        return await task();
      } finally {
        active.set(key, (active.get(key) ?? 1) - 1);
      }
    },
  };
}

/**
 * Wraps a metadata API in the backend gate above. The key matches
 * `metadata_gate_key`: connection id plus database (SQL Server ignores the
 * client session id there).
 */
function gateMetadataApi(gate: ReturnType<typeof createMetadataGate>, delays: { ddl: number; metadata: number }) {
  let inFlight = 0;
  let inFlightPeak = 0;
  let calls = 0;
  const key = (connectionId: string, database: string) => `${connectionId}\u0000${database}`;
  const run = <T>(connectionId: string, database: string, delay: number, task: () => T) =>
    gate.run(key(connectionId, database), async () => {
      inFlight += 1;
      inFlightPeak = Math.max(inFlightPeak, inFlight);
      calls += 1;
      try {
        // `0` means "no artificial latency": the fake gate decides admission
        // synchronously, so the fan-out model under test does not depend on a
        // timer, and a large-scale case can skip hundreds of sequential timers.
        if (delay > 0) await wait(delay);
        return task();
      } finally {
        inFlight -= 1;
      }
    });

  const api: SchemaDiffMetadataApi = {
    getTableDdl: (connectionId, database, _schema, table) => run(connectionId, database, delays.ddl, () => `ddl:${table}`),
    getColumns: (connectionId, database) => run(connectionId, database, delays.metadata, () => []),
    listIndexes: (connectionId, database) => run(connectionId, database, delays.metadata, () => []),
    listForeignKeys: (connectionId, database) => run(connectionId, database, delays.metadata, () => []),
    listTriggers: (connectionId, database) => run(connectionId, database, delays.metadata, () => []),
  };

  return { api, inFlightPeak: () => inFlightPeak, calls: () => calls };
}

function sqlserverTables(...names: string[]): TableInfo[] {
  return names.map((name) => ({ name, table_type: "TABLE" }) as TableInfo);
}

describe("schemaDiffMetadataLoad", () => {
  it("uses adaptive metadata concurrency for MySQL-compatible databases", () => {
    expect(schemaDiffMetadataConcurrency("mysql")).toBe(2);
    expect(schemaDiffMetadataConcurrency("MariaDB")).toBe(2);
    expect(schemaDiffMetadataConcurrency("mysql", 30)).toBe(4);
    expect(schemaDiffMetadataConcurrency("mysql", 31)).toBe(2);
    expect(schemaDiffMetadataConcurrency("MariaDB", 12)).toBe(4);
    expect(schemaDiffMetadataConcurrency("postgres")).toBe(6);
    expect(schemaDiffMetadataConcurrency("postgres", 100)).toBe(6);
    expect(schemaDiffMetadataConcurrency(undefined)).toBe(6);
  });

  it("uses one serialized metadata request for SQL Server", () => {
    // The backend gate admits `METADATA_POOL_SQLSERVER_LIMIT = 1` in-flight
    // request per (connection, database) and both SQL Server pools hold one
    // serialized session, so any extra fan-out only queues until it fails.
    // Native and `sqlserver-legacy` share one dbType and one limit, so there is
    // no driver-profile branch to make here.
    expect(schemaDiffMetadataConcurrency("sqlserver")).toBe(1);
    expect(schemaDiffMetadataConcurrency("SQLServer", 12)).toBe(1);
    expect(schemaDiffMetadataConcurrency("sqlserver", 500)).toBe(1);
  });

  it("keeps SQL Server metadata fan-out inside the backend gate", async () => {
    const gate = createMetadataGate(1);
    const { api, inFlightPeak } = gateMetadataApi(gate, { ddl: 4, metadata: 1 });

    const details = await loadSchemaDetails(
      sqlserverTables("orders", "customers", "events", "invoices", "items", "audit"),
      {
        connectionId: "9596-fanout",
        database: "app",
        schema: "dbo",
        dbType: "sqlserver",
        // SQL Server falls back to the PostgreSQL option tree today
        // (`getSchemaDiffOptionsForDbType`), which fetches DDL for every table.
        options: { ...DEFAULT_POSTGRES_OPTIONS },
      },
      api,
    );

    expect(details.map((detail) => detail.name)).toEqual(["orders", "customers", "events", "invoices", "items", "audit"]);
    expect(details.map((detail) => detail.ddl)).toEqual(["ddl:orders", "ddl:customers", "ddl:events", "ddl:invoices", "ddl:items", "ddl:audit"]);
    expect(gate.peak()).toBe(1);
    expect(inFlightPeak()).toBe(1);
  });

  it("keeps a large SQL Server schema inside the metadata gate", async () => {
    // Regression for #9596 at the reporter's scale: compares over a handful of
    // tables succeed there, while "more than 100 tables" reproduces
    // `DBX metadata pool is busy` every time. 100 is a field observation, not
    // a code threshold -- the failure comes from the 6-wide fan-out queueing on
    // a capacity-1 resource, and a bigger schema adds metadata volume, tail
    // latency and time windows where other metadata work shares the same
    // permit. So this case scales the workload instead of special-casing a
    // table count: the capacity fix has to hold for a realistically large
    // schema, not only for the six tables above.
    const tableCount = 120;
    const tables = sqlserverTables(...Array.from({ length: tableCount }, (_, index) => `table_${String(index).padStart(3, "0")}`));
    const gate = createMetadataGate(1);
    // No artificial latency: the fake gate decides admission synchronously, so
    // a 6-wide fan-out still trips it on the first burst, while 600 sequential
    // timers would only add wall clock (`setTimeout(1)` costs ~15ms on
    // Windows).
    const { api, inFlightPeak, calls } = gateMetadataApi(gate, { ddl: 0, metadata: 0 });

    const details = await loadSchemaDetails(
      tables,
      {
        connectionId: "9596-large-schema",
        database: "app",
        schema: "dbo",
        dbType: "sqlserver",
        options: { ...DEFAULT_POSTGRES_OPTIONS },
      },
      api,
    );

    expect(details).toHaveLength(tableCount);
    expect(details.every((detail) => detail.ddl === `ddl:${detail.name}`)).toBe(true);
    // 5 metadata requests per table (DDL + columns + indexes + foreign keys +
    // triggers), every one of them admitted by a single capacity-1 permit.
    expect(calls()).toBe(tableCount * 5);
    expect(gate.peak()).toBe(1);
    expect(inFlightPeak()).toBe(1);
  });

  it("would trip the SQL Server metadata gate at the fan-out used before the fix", async () => {
    const gate = createMetadataGate(1);
    const runFanOut = createConcurrencyLimiter(6);

    await expect(Promise.all(Array.from({ length: 6 }, () => runFanOut(() => gate.run("9596-fanout\u0000app", () => wait(1)))))).rejects.toThrow(METADATA_POOL_BUSY);
  });

  it("keeps SQL Server schema compare source and target databases inside the gate", async () => {
    const gate = createMetadataGate(1);
    const { api } = gateMetadataApi(gate, { ddl: 3, metadata: 1 });
    const context = (database: string) => ({
      connectionId: "9596-same-connection",
      database,
      schema: "dbo",
      dbType: "sqlserver",
      options: { ...DEFAULT_POSTGRES_OPTIONS },
    });
    const tables = sqlserverTables("orders", "customers", "events");

    const source = await loadSchemaDetails(tables, context("app_source"), api);
    const target = await loadSchemaDetails(tables, context("app_target"), api);

    expect(source).toHaveLength(3);
    expect(target).toHaveLength(3);
    expect(gate.peak()).toBe(1);
  });

  it("queues concurrent SQL Server compares on one metadata resource instead of failing on the gate", async () => {
    const gate = createMetadataGate(1);
    const { api } = gateMetadataApi(gate, { ddl: 4, metadata: 1 });
    const context = {
      connectionId: "9596-background",
      database: "app",
      schema: "dbo",
      dbType: "sqlserver",
      options: { ...DEFAULT_POSTGRES_OPTIONS },
    };
    const tables = sqlserverTables("orders", "customers", "events", "invoices");

    const [foreground, background] = await Promise.all([loadSchemaDetails(tables, context, api), loadSchemaDetails(tables, context, api)]);

    expect(foreground).toHaveLength(4);
    expect(background).toHaveLength(4);
    expect(gate.peak()).toBe(1);
  });

  it("keeps one shared lane for a compare starting after another compare's first table", async () => {
    // Regression: the lane used to be evicted by the limiter's idle callback,
    // which at SQL Server's concurrency of 1 fires at every table boundary --
    // mid-compare. A compare starting there built a second 1-wide lane, and the
    // two fan-outs together overran the backend's capacity-1 gate with
    // `DBX metadata pool is busy`. The lane must instead live as long as the
    // compares actively using it hold it.
    const gate = createMetadataGate(1);
    const { api } = gateMetadataApi(gate, { ddl: 4, metadata: 1 });
    const context = {
      connectionId: "9596-mid-flight",
      database: "app",
      schema: "dbo",
      dbType: "sqlserver",
      options: { ...DEFAULT_POSTGRES_OPTIONS },
    };
    const tables = sqlserverTables("orders", "customers", "events", "invoices");

    let resolvePastFirstTable!: () => void;
    const pastFirstTable = new Promise<void>((resolve) => {
      resolvePastFirstTable = resolve;
    });

    const first = loadSchemaDetails(
      tables,
      {
        ...context,
        onProgress: (value) => {
          if (value.current >= 2) resolvePastFirstTable();
        },
      },
      api,
    );
    await pastFirstTable;
    // The first compare is past a table boundary, exactly where the old
    // idle-based eviction had already removed its lane mid-compare.
    expect(schemaDiffMetadataLaneCountForTests()).toBe(1);

    const second = loadSchemaDetails(tables, context, api);
    const [firstDetails, secondDetails] = await Promise.all([first, second]);

    expect(firstDetails).toHaveLength(4);
    expect(secondDetails).toHaveLength(4);
    expect(gate.peak()).toBe(1);
    expect(schemaDiffMetadataLaneCountForTests()).toBe(0);
  });

  it("does not pin the metadata lane when the table list is empty", async () => {
    // An empty compare (a filter that matches nothing) never runs a metadata
    // request, so limiter activity alone can never free the lane. The call's
    // own hold must release it, or the lane stays pinned in the map forever.
    const gate = createMetadataGate(1);
    const { api, calls } = gateMetadataApi(gate, { ddl: 0, metadata: 0 });

    const details = await loadSchemaDetails(
      [],
      {
        connectionId: "9596-empty-tables",
        database: "app",
        schema: "dbo",
        dbType: "sqlserver",
        options: { ...DEFAULT_POSTGRES_OPTIONS },
      },
      api,
    );

    expect(details).toEqual([]);
    expect(calls()).toBe(0);
    expect(schemaDiffMetadataLaneCountForTests()).toBe(0);
  });

  it("keeps the lane alive until a failed compare's queued requests drain", async () => {
    // A failed compare stops awaiting requests it already queued: its
    // `Promise.all` rejects while the remaining requests keep running on the
    // lane. Those orphans must keep the lane in the map so an immediate retry
    // shares it instead of racing the orphans on the gate with a second lane.
    let active = 0;
    let peak = 0;
    const track = async <T>(task: () => Promise<T>) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await task();
      } finally {
        active -= 1;
      }
    };
    const api: SchemaDiffMetadataApi = {
      getTableDdl: async (_connectionId, _database, _schema, table) =>
        track(async () => {
          await wait(6);
          return `ddl:${table}`;
        }),
      getColumns: async () => {
        throw new Error("columns failed");
      },
      listIndexes: async () =>
        track(async () => {
          await wait(6);
          return [];
        }),
      listForeignKeys: async () =>
        track(async () => {
          await wait(6);
          return [];
        }),
      listTriggers: async () =>
        track(async () => {
          await wait(6);
          return [];
        }),
    };
    const context = {
      connectionId: "9596-orphan-drain",
      database: "app",
      schema: "dbo",
      dbType: "sqlserver",
      options: { ...DEFAULT_POSTGRES_OPTIONS },
    };
    const tables = sqlserverTables("orders", "customers");

    await expect(loadSchemaDetails(tables, context, api)).rejects.toThrow("columns failed");
    // The compare has failed, but its queued index/key/trigger requests are
    // still draining behind it: the lane must still exist for the retry.
    expect(schemaDiffMetadataLaneCountForTests()).toBe(1);

    await expect(loadSchemaDetails(tables, context, api)).rejects.toThrow("columns failed");
    for (let attempt = 0; attempt < 100 && schemaDiffMetadataLaneCountForTests() > 0; attempt += 1) await wait(1);
    expect(schemaDiffMetadataLaneCountForTests()).toBe(0);
    expect(peak).toBe(1);
  });

  it("keeps SQL Server metadata lanes independent per database", async () => {
    const gate = createMetadataGate(1);
    const { api, inFlightPeak } = gateMetadataApi(gate, { ddl: 4, metadata: 1 });
    const context = (database: string) => ({
      connectionId: "9596-lanes",
      database,
      schema: "dbo",
      dbType: "sqlserver",
      options: { ...DEFAULT_POSTGRES_OPTIONS },
    });
    const tables = sqlserverTables("orders", "customers");

    await Promise.all([loadSchemaDetails(tables, context("app_a"), api), loadSchemaDetails(tables, context("app_b"), api)]);

    expect(gate.peak()).toBe(1);
    expect(inFlightPeak()).toBe(2);
  });

  it("skips view DDL when views are disabled while preserving table DDL options", () => {
    expect(shouldFetchSchemaDiffDdl(true, { tables: true, views: false })).toBe(false);
    expect(shouldFetchSchemaDiffDdl(true, { tables: false, views: true })).toBe(true);
    expect(shouldFetchSchemaDiffDdl(false, { tables: false, views: true })).toBe(false);
    expect(shouldFetchSchemaDiffDdl(false, { tables: true, views: false })).toBe(true);
  });

  it("uses DDL-only metadata for views so invalid definers cannot break column discovery", () => {
    expect(
      schemaDiffMetadataLoadPlan(true, {
        tables: true,
        views: true,
        indexes: true,
        primaryKeys: true,
        uniqueKeys: true,
        foreignKeys: true,
        triggers: true,
      }),
    ).toEqual({
      columns: false,
      indexes: false,
      foreignKeys: false,
      triggers: false,
      ddl: true,
    });
  });

  it("does not load any metadata for disabled views", () => {
    expect(
      schemaDiffMetadataLoadPlan(true, {
        tables: true,
        views: false,
        indexes: true,
        primaryKeys: true,
        uniqueKeys: true,
        foreignKeys: true,
        triggers: true,
      }),
    ).toEqual({
      columns: false,
      indexes: false,
      foreignKeys: false,
      triggers: false,
      ddl: false,
    });
  });

  it("preserves enabled relational metadata for tables", () => {
    expect(
      schemaDiffMetadataLoadPlan(false, {
        tables: true,
        views: false,
        indexes: false,
        primaryKeys: true,
        uniqueKeys: false,
        foreignKeys: true,
        triggers: false,
      }),
    ).toEqual({
      columns: true,
      indexes: true,
      foreignKeys: true,
      triggers: false,
      ddl: true,
    });
  });

  it("maps items with limited concurrency and preserves output order", async () => {
    let active = 0;
    let maxActive = 0;

    const result = await mapWithConcurrency([30, 5, 10, 1], 2, async (delay, index) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await wait(delay);
      active -= 1;
      return `${index}:${delay}`;
    });

    expect(result).toEqual(["0:30", "1:5", "2:10", "3:1"]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("reports each completed table while loading metadata", async () => {
    const tables = ["orders", "customers", "events"].map((name) => ({ name, table_type: "TABLE" }) as TableInfo);
    const progress: SchemaDiffMetadataProgress[] = [];
    const api: SchemaDiffMetadataApi = {
      getTableDdl: async (_connectionId, _database, _schema, table) => {
        await wait(table === "orders" ? 10 : table === "customers" ? 1 : 5);
        return `ddl:${table}`;
      },
      getColumns: async () => [],
      listIndexes: async () => [],
      listForeignKeys: async () => [],
      listTriggers: async () => [],
    };

    const details = await loadSchemaDetails(
      tables,
      {
        connectionId: "source",
        database: "db",
        schema: "public",
        dbType: "mysql",
        options: { ...DEFAULT_MYSQL_OPTIONS },
        onProgress: (value) => progress.push(value),
      },
      api,
    );

    expect(details.map((detail) => detail.name)).toEqual(["orders", "customers", "events"]);
    expect(details.map((detail) => detail.ddl)).toEqual(["ddl:orders", "ddl:customers", "ddl:events"]);
    expect(progress.map((value) => value.current)).toEqual([1, 2, 3]);
    expect(progress.map((value) => value.total)).toEqual([3, 3, 3]);
    expect(new Set(progress.map((value) => value.objectName))).toEqual(new Set(["orders", "customers", "events"]));
  });

  it("propagates the first worker error and stops scheduling new work", async () => {
    const started: number[] = [];

    await expect(
      mapWithConcurrency([1, 2, 3], 1, async (item) => {
        started.push(item);
        if (item === 2) throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow("boom");

    expect(started).toEqual([1, 2]);
  });

  it("limits arbitrary async tasks", async () => {
    const runLimited = createConcurrencyLimiter(2);
    let active = 0;
    let maxActive = 0;

    const result = await Promise.all(
      [8, 6, 4, 2].map((delay, index) =>
        runLimited(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await wait(delay);
          active -= 1;
          return index;
        }),
      ),
    );

    expect(result).toEqual([0, 1, 2, 3]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("only enables extra objects for PostgreSQL-like databases with relevant options", () => {
    expect(shouldLoadSchemaDiffExtraObjects("mysql", { ...DEFAULT_MYSQL_OPTIONS, functions: true })).toBe(false);
    expect(shouldLoadSchemaDiffExtraObjects("postgres", DEFAULT_POSTGRES_OPTIONS)).toBe(true);
    expect(shouldLoadSchemaDiffExtraObjects("opengauss", DEFAULT_POSTGRES_OPTIONS)).toBe(true);
    expect(
      shouldLoadSchemaDiffExtraObjects("postgres", {
        ...DEFAULT_POSTGRES_OPTIONS,
        functions: false,
        sequences: false,
        rules: false,
        owners: false,
      }),
    ).toBe(false);
  });

  it("treats supported same-dialect routine compare as an extra-object progress phase", () => {
    expect(shouldLoadSchemaDiffRoutines("mysql", "mysql", { functions: true })).toBe(true);
    expect(shouldLoadSchemaDiffRoutines("mysql", "oracle", { functions: true })).toBe(false);
    expect(shouldLoadSchemaDiffRoutines("mysql", "sqlite", { functions: true })).toBe(false);
    expect(shouldLoadSchemaDiffRoutines("mysql", "mysql", { functions: false })).toBe(false);
    expect(shouldLoadSchemaDiffExtraObjectPhase("mysql", "mysql", DEFAULT_MYSQL_OPTIONS)).toBe(true);
    expect(shouldLoadSchemaDiffExtraObjectPhase("mysql", "mysql", { ...DEFAULT_MYSQL_OPTIONS, functions: false })).toBe(false);
    expect(shouldLoadSchemaDiffExtraObjectPhase("postgres", "postgres", DEFAULT_POSTGRES_OPTIONS)).toBe(true);
  });

  it("maps phases to the next step on the actual comparison path", () => {
    expect(getSchemaDiffNextProgressStep("loading-table-lists", false)).toBe("nextSourceDetails");
    expect(getSchemaDiffNextProgressStep("loading-source-details", false)).toBe("nextTargetDetails");
    expect(getSchemaDiffNextProgressStep("loading-target-details", false)).toBe("nextComparing");
    expect(getSchemaDiffNextProgressStep("loading-target-details", true)).toBe("nextExtraObjects");
    expect(getSchemaDiffNextProgressStep("loading-extra-objects", true)).toBe("nextComparing");
    expect(getSchemaDiffNextProgressStep("comparing", false)).toBe("nextGenerating");
    expect(getSchemaDiffNextProgressStep("generating", false)).toBe("nextComplete");
    expect(getSchemaDiffNextProgressStep("complete", false)).toBeNull();
    expect(getSchemaDiffNextProgressStep(undefined, false)).toBeNull();
  });
});
