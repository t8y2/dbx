import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { executeWithProductionContextGuard, executeWithProductionSqlGuard } from "../productionExecutionGuard";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { useReadOnlyUnlockStore } from "@/stores/readOnlyUnlockStore";
import type { ConnectionConfig } from "@/types/database";

function connection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "conn-1",
    name: "Operations",
    db_type: "mysql",
    host: "db.internal",
    port: 3306,
    username: "operator",
    password: "",
    production_databases: ["prod_app"],
    ...overrides,
  };
}

describe("production SQL execution guard", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("waits for confirmation before executing production SQL", async () => {
    const execute = vi.fn().mockResolvedValue("done");
    const pendingExecution = executeWithProductionSqlGuard({
      connection: connection(),
      database: "prod_app",
      sql: "DELETE FROM users WHERE id = 1",
      source: "Schema diff",
      execute,
    });

    await Promise.resolve();
    const store = useProductionSafetyStore();
    expect(store.pending).toMatchObject({
      sql: "DELETE FROM users WHERE id = 1",
      database: "prod_app",
      productionDatabases: ["prod_app"],
      source: "Schema diff",
    });
    expect(execute).not.toHaveBeenCalled();

    store.confirm();
    await expect(pendingExecution).resolves.toBe("done");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reviews the entire batch mutation once and executes its callback once", async () => {
    const batchSql = ['ALTER PROCEDURE "APP"."P1" COMPILE REUSE SETTINGS', 'ALTER PACKAGE "APP"."PKG" COMPILE SPECIFICATION REUSE SETTINGS', 'ALTER PACKAGE "APP"."PKG" COMPILE BODY REUSE SETTINGS'].join(";\n");
    const execute = vi.fn().mockResolvedValue("completed");
    const pending = executeWithProductionSqlGuard({
      connection: connection({ db_type: "oracle", production_databases: ["app"] }),
      database: "APP",
      sql: batchSql,
      source: "Invalid objects batch",
      execute,
    });

    await Promise.resolve();
    expect(useProductionSafetyStore().pending).toMatchObject({ sql: batchSql, database: "APP", source: "Invalid objects batch" });
    expect(execute).not.toHaveBeenCalled();
    useProductionSafetyStore().confirm();
    await expect(pending).resolves.toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("blocks a batch on a read-only connection until write access is explicitly unlocked", async () => {
    const execute = vi.fn().mockResolvedValue("completed");
    const pending = executeWithProductionSqlGuard({
      connection: connection({ db_type: "oracle", read_only: true }),
      database: "APP",
      sql: 'ALTER PROCEDURE "APP"."P1" COMPILE;\nALTER PROCEDURE "APP"."P2" COMPILE',
      source: "Invalid objects batch",
      execute,
    });

    await vi.waitFor(() => expect(useReadOnlyUnlockStore().pending?.connectionId).toBe("conn-1"));
    expect(execute).not.toHaveBeenCalled();
    useReadOnlyUnlockStore().cancel();
    await expect(pending).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels production SQL without executing the callback", async () => {
    const execute = vi.fn().mockResolvedValue("done");
    const pendingExecution = executeWithProductionSqlGuard({
      connection: connection(),
      database: "prod_app",
      sql: "TRUNCATE TABLE users",
      source: "Object tree",
      execute,
    });

    await Promise.resolve();
    useProductionSafetyStore().cancel();

    await expect(pendingExecution).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("queues concurrent production confirmations", async () => {
    const firstExecute = vi.fn().mockResolvedValue("first");
    const secondExecute = vi.fn().mockResolvedValue("second");
    const firstSql = "DELETE FROM prod_app.users WHERE id = 1";
    const secondSql = "DELETE FROM prod_app.audit_log WHERE id = 2";
    const firstExecution = executeWithProductionSqlGuard({
      connection: connection(),
      database: "staging",
      sql: firstSql,
      source: "Schema diff",
      execute: firstExecute,
    });
    const secondExecution = executeWithProductionSqlGuard({
      connection: connection(),
      database: "staging",
      sql: secondSql,
      source: "Data compare",
      execute: secondExecute,
    });

    await Promise.resolve();
    const store = useProductionSafetyStore();
    expect(store.pending?.sql).toBe(firstSql);
    expect(firstExecute).not.toHaveBeenCalled();
    expect(secondExecute).not.toHaveBeenCalled();

    store.confirm();
    await expect(firstExecution).resolves.toBe("first");
    expect(firstExecute).toHaveBeenCalledTimes(1);
    expect(store.pending?.sql).toBe(secondSql);

    store.cancel();
    await expect(secondExecution).resolves.toBeUndefined();
    expect(secondExecute).not.toHaveBeenCalled();
  });

  it("executes non-production SQL immediately", async () => {
    const execute = vi.fn().mockResolvedValue("done");
    await expect(
      executeWithProductionSqlGuard({
        connection: connection(),
        database: "staging",
        sql: "UPDATE staging.users SET active = 1 WHERE id = 1",
        source: "Data compare",
        execute,
      }),
    ).resolves.toBe("done");

    expect(useProductionSafetyStore().pending).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("production context execution guard (non-SQL)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("waits for confirmation before executing production non-SQL mutations", async () => {
    const execute = vi.fn().mockResolvedValue("renamed");
    const reviewText = 'db.getSiblingDB("app").getCollection("users").renameCollection("accounts")';
    const pendingExecution = executeWithProductionContextGuard({
      connection: connection({ db_type: "mongodb", is_production: true }),
      database: "app",
      reviewText,
      source: "Object tree",
      execute,
    });

    await Promise.resolve();
    const store = useProductionSafetyStore();
    expect(store.pending).toMatchObject({
      sql: reviewText,
      database: "app",
      source: "Object tree",
    });
    expect(execute).not.toHaveBeenCalled();

    store.confirm();
    await expect(pendingExecution).resolves.toBe("renamed");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("cancels production non-SQL mutations without executing the callback", async () => {
    const execute = vi.fn().mockResolvedValue("renamed");
    const pendingExecution = executeWithProductionContextGuard({
      connection: connection({ db_type: "mongodb", production_databases: ["app"] }),
      database: "app",
      reviewText: 'db.getCollection("users").renameCollection("accounts")',
      source: "Object tree",
      execute,
    });

    await Promise.resolve();
    useProductionSafetyStore().cancel();

    await expect(pendingExecution).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes non-production non-SQL mutations immediately", async () => {
    const execute = vi.fn().mockResolvedValue("renamed");
    await expect(
      executeWithProductionContextGuard({
        connection: connection({ db_type: "mongodb" }),
        database: "scratch",
        reviewText: 'db.getCollection("users").renameCollection("accounts")',
        source: "Object tree",
        execute,
      }),
    ).resolves.toBe("renamed");

    expect(useProductionSafetyStore().pending).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("connection scope confirms any marked database even when the current schema is unmarked", async () => {
    const execute = vi.fn().mockResolvedValue("killed");
    const pending = executeWithProductionContextGuard({
      connection: connection({ db_type: "oracle", production_databases: ["PROD_A", "PROD_B"] }),
      database: "scratch",
      reviewText: "terminate session 42",
      scope: "connection",
      execute,
    });
    await Promise.resolve();
    expect(useProductionSafetyStore().pending).toMatchObject({ productionDatabases: ["prod_a", "prod_b"] });
    useProductionSafetyStore().confirm();
    await expect(pending).resolves.toBe("killed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("connection scope leaves unmarked connections immediate and preserves the default database scope", async () => {
    const execute = vi.fn().mockResolvedValue("done");
    await expect(executeWithProductionContextGuard({ connection: connection({ db_type: "oracle", production_databases: [] }), database: "scratch", reviewText: "terminate session", scope: "connection", execute })).resolves.toBe("done");
    await expect(executeWithProductionContextGuard({ connection: connection({ db_type: "oracle", production_databases: ["prod_a"] }), database: "scratch", reviewText: "legacy action", execute })).resolves.toBe("done");
    expect(useProductionSafetyStore().pending).toBeUndefined();
  });
});
