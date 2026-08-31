import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import { manifestDatabaseTypes, supportsDatabaseFeature } from "@/lib/database/databaseDriverManifest";
import {
  normalizeSqlExecutionTarget,
  sqlExecutionTargetCapabilities,
  targetAllowsEmptyDatabase,
  targetCanUseDefaultWhenDatabaseListEmpty,
  targetDefaultDatabase,
  targetIsSingleDatabase,
  targetSupportsSchema,
  targetUsesConnectionOnlyScope,
  targetUsesNamespaceScope,
} from "@/lib/database/sqlExecutionTargetCapabilities";
import { normalizeSqlExecutionTargetContext, resolveSqlExecutionTargetProvider } from "@/lib/database/sqlExecutionTargetRegistry";

function connection(overrides: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    id: "connection-1",
    name: "Test connection",
    db_type: "mysql",
    host: "localhost",
    port: 3306,
    username: "user",
    password: "",
    ...overrides,
  };
}

describe("sql execution target capabilities", () => {
  it("exposes a target capability for every manifest database type with query execution", () => {
    for (const dbType of manifestDatabaseTypes()) {
      if (!supportsDatabaseFeature(dbType, "queryExecution")) continue;
      expect(sqlExecutionTargetCapabilities(connection({ db_type: dbType })), dbType).toBeDefined();
    }
  });

  it("models connection-only query targets without database or schema", () => {
    const config = connection({ db_type: "etcd" });
    const capabilities = sqlExecutionTargetCapabilities(config);

    expect(capabilities?.scope).toBe("connection");
    expect(capabilities?.supportsDatabase).toBe(false);
    expect(capabilities?.supportsSchema).toBe(false);
    expect(targetUsesConnectionOnlyScope(config)).toBe(true);
    expect(targetAllowsEmptyDatabase(config)).toBe(true);
    expect(normalizeSqlExecutionTarget(config, { connectionId: config.id, database: "stale", catalog: "old", schema: "old" })).toEqual({
      connectionId: config.id,
      database: "",
    });
  });

  it("models document and vector query targets as connection-only until a namespace provider exists", () => {
    const config = connection({ db_type: "qdrant" });
    const capabilities = sqlExecutionTargetCapabilities(config);

    expect(capabilities?.scope).toBe("connection");
    expect(capabilities?.supportsDatabase).toBe(false);
    expect(capabilities?.supportsSchema).toBe(false);
    expect(targetUsesNamespaceScope(config)).toBe(false);
    expect(targetUsesConnectionOnlyScope(config)).toBe(true);
    expect(normalizeSqlExecutionTarget(config, { connectionId: config.id, database: "collection", schema: "stale" })).toEqual({
      connectionId: config.id,
      database: "",
    });
  });

  it("uses the registered VictoriaMetrics default without treating arbitrary names as valid", () => {
    const config = connection({ db_type: "victoriametrics", database: undefined });
    const capabilities = sqlExecutionTargetCapabilities(config);

    expect(capabilities?.defaultDatabase).toBe("metrics");
    expect(targetDefaultDatabase(config)).toBe("metrics");
    expect(targetCanUseDefaultWhenDatabaseListEmpty(config)).toBe(true);
    expect(targetIsSingleDatabase(config)).toBe(true);
    expect(targetAllowsEmptyDatabase(config)).toBe(true);
  });

  it("uses the effective JDBC dialect for target semantics", () => {
    const oracle = connection({ db_type: "jdbc", connection_string: "jdbc:oracle:thin:@localhost:1521/XEPDB1" });
    const postgres = connection({ db_type: "jdbc", connection_string: "jdbc:postgresql://localhost:5432/app" });

    expect(sqlExecutionTargetCapabilities(oracle)?.databaseType).toBe("oracle");
    expect(targetIsSingleDatabase(oracle)).toBe(true);
    expect(targetSupportsSchema(oracle)).toBe(true);
    expect(sqlExecutionTargetCapabilities(postgres)?.databaseType).toBe("postgres");
    expect(targetIsSingleDatabase(postgres)).toBe(false);
    expect(targetSupportsSchema(postgres)).toBe(true);
  });

  it("prefers a configured PostgreSQL database for the stable default", () => {
    const config = connection({ db_type: "postgres", database: "app" });

    expect(targetDefaultDatabase(config)).toBe("app");
    expect(targetCanUseDefaultWhenDatabaseListEmpty(config)).toBe(true);
    expect(sqlExecutionTargetCapabilities(config)?.provider.id).toBe("builtin:database");
  });

  it("maps every built-in target scope through the shared provider contract", () => {
    const databaseProvider = resolveSqlExecutionTargetProvider("database");
    const connectionProvider = resolveSqlExecutionTargetProvider("connection");
    const config = connection({ id: "conn-1", db_type: "postgres" });

    expect(databaseProvider.toExecutionContext({ connectionId: "conn-1", database: "app", schema: "public" }, config)).toEqual({
      scope: "database",
      database: "app",
      schema: "public",
    });
    expect(connectionProvider.toExecutionContext({ connectionId: "conn-1", database: "" }, config)).toEqual({ scope: "connection" });
    expect(normalizeSqlExecutionTargetContext({ scope: "connection", database: "stale", schema: "stale", catalog: "stale" })).toEqual({ scope: "connection" });
  });

  it("rejects stale namespace fields on a connection-scoped target", () => {
    const config = connection({ id: "conn-1", db_type: "etcd" });
    const provider = sqlExecutionTargetCapabilities(config)!.provider;

    expect(() => provider.validateTarget({ connectionId: "conn-1", database: "old", schema: "old" }, config)).toThrow();
  });

  it("does not expose targets for connections without query execution capability", () => {
    expect(sqlExecutionTargetCapabilities(connection({ db_type: "mq" }))).toBeUndefined();
  });
});
