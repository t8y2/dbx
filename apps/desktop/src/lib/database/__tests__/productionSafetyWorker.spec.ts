import { afterEach, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { assessProductionSqlInBackground, type ProductionSafetyRequest } from "../productionSafetyWorker";
import { assessProductionSql } from "../productionSafety";

class TestWorker {
  static instances: TestWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  terminate = vi.fn();
  request?: { id: number; input: ProductionSafetyRequest };
  constructor() {
    TestWorker.instances.push(this);
  }
  postMessage(request: { id: number; input: ProductionSafetyRequest }) {
    // Also catches accidentally passing a Vue connection proxy to the worker.
    this.request = structuredClone(request);
  }
  respond() {
    const { id, input } = this.request!;
    this.onmessage?.({ data: { id, result: assessProductionSql(input.sql, input.connection, input.database) } });
  }
}

afterEach(() => {
  TestWorker.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("assesses qualified production targets without sending connection secrets", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const pending = assessProductionSqlInBackground({
    sql: "UPDATE prod_app.users SET active = 1 WHERE id = 1",
    database: "scratch",
    connection: reactive({ db_type: "mysql" as const, production_databases: ["prod_app"], password: "not-for-worker" }),
  });
  const worker = TestWorker.instances[0]!;
  expect(worker.request?.input.connection).toEqual({ db_type: "mysql", is_production: undefined, production_databases: ["prod_app"] });
  worker.respond();
  await expect(pending).resolves.toMatchObject({ active: true, isMutation: true, databases: ["prod_app"] });
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it("preserves safety checks if the worker cannot start", async () => {
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw new Error("workers unavailable");
      }
    },
  );
  await expect(assessProductionSqlInBackground({ sql: "DELETE FROM users", database: "prod", connection: { db_type: "mysql", production_databases: ["prod"] } })).resolves.toMatchObject({ active: true, isMutation: true });
});

it("does not cancel a concurrent assessment", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const first = assessProductionSqlInBackground({ sql: "SELECT 1" });
  const second = assessProductionSqlInBackground({ sql: "DELETE FROM users" });
  TestWorker.instances[1]!.respond();
  TestWorker.instances[0]!.respond();
  await expect(first).resolves.toMatchObject({ isMutation: false });
  await expect(second).resolves.toMatchObject({ isMutation: true });
});

it("rejects a stalled analysis and releases the worker", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", TestWorker);
  const pending = assessProductionSqlInBackground({ sql: "DELETE FROM users" });
  const assertion = expect(pending).rejects.toThrow("SQL safety analysis timed out");
  await vi.advanceTimersByTimeAsync(30_000);
  await assertion;
  expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
});
