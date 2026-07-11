import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { executeWithProductionSqlGuard } from "../productionExecutionGuard";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
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
