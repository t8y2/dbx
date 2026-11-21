import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDatabaseUserAdminProvider } from "@/lib/database/databaseUserAdmin";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import type { ConnectionConfig } from "@/types/database";

describe("Vastbase password production guard", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it.each([true, false])("executes password SQL only when confirmation is %s", async (confirmed) => {
    const connection: ConnectionConfig = { id: "vastbase-guard", name: "Fixture", db_type: "vastbase", host: "localhost", port: 5432, username: "fixture_self", password: "", is_production: true };
    const sql = getDatabaseUserAdminProvider("vastbase")!.alterPasswordSql!({ user: "fixture_self", host: "LOGIN" }, "fixture-new", "fixture-old");
    const execute = vi.fn().mockResolvedValue([]);
    const pending = executeWithProductionSqlGuard({ connection, database: "", sql, execute });
    await vi.waitFor(() => expect(useProductionSafetyStore().pending?.sql).toBe(sql));
    expect(execute).not.toHaveBeenCalled();
    if (confirmed) useProductionSafetyStore().confirm();
    else useProductionSafetyStore().cancel();
    await pending;
    expect(execute).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    expect(useProductionSafetyStore().pending).toBeUndefined();
  });
});
