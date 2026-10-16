import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listTables: vi.fn().mockResolvedValue([{ name: "orders", table_type: "TABLE" }]),
  getColumns: vi.fn().mockResolvedValue([{ name: "user_id" }, { name: "amount" }]),
  listForeignKeys: vi.fn().mockResolvedValue([]),
  getTableDdl: vi.fn().mockResolvedValue("CREATE VIEW v AS SELECT user_id FROM orders"),
  loadHistory: vi.fn().mockResolvedValue([]),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/backend/api", () => ({
  listTables: mocks.listTables,
  getColumns: mocks.getColumns,
  listForeignKeys: mocks.listForeignKeys,
  getTableDdl: mocks.getTableDdl,
  loadHistory: mocks.loadHistory,
}));

import { cancelFieldLineageSession, findFieldLineageSession, getFieldLineageSession, startFieldLineageSession } from "@/composables/useFieldLineageSession";

const config = { connectionId: "conn-1", database: "shop", schema: "public", table: "orders", column: "user_id" };
const deps = { ensureConnected: mocks.ensureConnected };

async function waitForStatus(sessionId: string, status: string) {
  await vi.waitFor(() => {
    expect(getFieldLineageSession(sessionId)?.status).toBe(status);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useFieldLineageSession", () => {
  it("runs the analysis to completion outside any component", async () => {
    const session = startFieldLineageSession(config, deps);
    expect(session.status).toBe("running");

    await waitForStatus(session.id, "completed");
    const done = getFieldLineageSession(session.id)!;
    expect(done.result).not.toBeNull();
    expect(done.error).toBeNull();
    expect(mocks.listTables).toHaveBeenCalledWith("conn-1", "shop", "public");
  });

  it("re-attaches a same-config session instead of re-running it (multi-field switchback safety)", async () => {
    const first = startFieldLineageSession(config, deps);
    await waitForStatus(first.id, "completed");

    const found = findFieldLineageSession(config);
    expect(found?.id).toBe(first.id);
    expect(findFieldLineageSession({ ...config, column: "amount" })).toBeUndefined();
  });

  it("cancels a running analysis and reports the cancelled status", async () => {
    // Never-resolving column load keeps the run alive until cancel.
    let release: (() => void) | undefined;
    mocks.getColumns.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([{ name: "user_id" }]);
        }),
    );
    const session = startFieldLineageSession({ ...config, column: "amount" }, deps);
    expect(session.status).toBe("running");

    cancelFieldLineageSession(session.id);
    expect(getFieldLineageSession(session.id)?.status).toBe("cancelled");
    release?.();
  });
});
