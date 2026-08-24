import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import type { TreeNode } from "@/types/database";
import { dropTableCascade, dropTablePreviewSql, emptyTablePreviewSql, sidebarDangerRunningCancel, sidebarDangerRunningExecutionId, sidebarDangerTarget, truncateTableCascade, truncateTablePreviewSql } from "@/components/sidebar/sidebarTreeDialogState";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  buildDropTableSql: vi.fn(),
  buildEmptyTableSql: vi.fn(),
  buildTruncateTableSql: vi.fn(),
  ensureConnected: vi.fn(),
  executeWithProductionGuard: vi.fn(),
  closeDroppedTableObjectTabsForNode: vi.fn(),
  refreshMutatedTableDataTabsForNode: vi.fn(),
  removeTreeNode: vi.fn(),
  releaseActiveNodeReference: vi.fn(),
  cancelQuery: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/database/dbAdminSql", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/database/dbAdminSql")>()),
  buildDropTableSql: mocks.buildDropTableSql,
  buildEmptyTableSql: mocks.buildEmptyTableSql,
  buildTruncateTableSql: mocks.buildTruncateTableSql,
}));
vi.mock("@/lib/backend/api", () => ({ cancelQuery: mocks.cancelQuery }));

import { useSidebarTableMutationRuntime } from "@/composables/useSidebarTableMutationRuntime";

type ConfirmAction = "confirmDropTable" | "confirmEmptyTable" | "confirmTruncateTable";

const actions: Array<{ action: ConfirmAction; builder: typeof mocks.buildDropTableSql; sql: string }> = [
  { action: "confirmDropTable", builder: mocks.buildDropTableSql, sql: 'DROP TABLE "APP"."ORDERS";' },
  { action: "confirmEmptyTable", builder: mocks.buildEmptyTableSql, sql: 'DELETE FROM "APP"."ORDERS";' },
  { action: "confirmTruncateTable", builder: mocks.buildTruncateTableSql, sql: 'TRUNCATE TABLE "APP"."ORDERS";' },
];

function tableNode(database: string | null | undefined): TreeNode {
  return {
    id: "hana-1::APP:ORDERS",
    label: "ORDERS",
    type: "table",
    connectionId: "hana-1",
    database,
    schema: "APP",
    isExpanded: false,
  } as TreeNode;
}

function runtime(database: string | null | undefined) {
  const node = tableNode(database);
  const activeNode = shallowRef(node);
  const connectionStore = {
    ensureConnected: mocks.ensureConnected,
    removeTreeNode: mocks.removeTreeNode,
  } as any;
  const feature = useSidebarTableMutationRuntime({
    activeNode,
    releaseActiveNodeReference: mocks.releaseActiveNodeReference,
    connectionStore,
    currentDatabaseType: () => "saphana",
    databaseTypeForNode: () => "saphana",
    executeWithProductionGuard: mocks.executeWithProductionGuard,
    closeDroppedTableObjectTabsForNode: mocks.closeDroppedTableObjectTabsForNode,
    refreshMutatedTableDataTabsForNode: mocks.refreshMutatedTableDataTabsForNode,
  });
  return { feature, node };
}

describe("useSidebarTableMutationRuntime SAP HANA schema-scoped actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sidebarDangerTarget.value = null;
    sidebarDangerRunningExecutionId.value = "";
    sidebarDangerRunningCancel.value = null;
    dropTablePreviewSql.value = "";
    emptyTablePreviewSql.value = "";
    truncateTablePreviewSql.value = "";
    dropTableCascade.value = false;
    truncateTableCascade.value = false;
    mocks.ensureConnected.mockResolvedValue(undefined);
    // A non-undefined result models the real executeWithProductionGuard
    // resolving to whatever execute() returned (a QueryResult); it only
    // resolves to `undefined` when the user declines the production-safety
    // confirmation — see the dedicated "declines" test below.
    mocks.executeWithProductionGuard.mockResolvedValue({});
    mocks.refreshMutatedTableDataTabsForNode.mockResolvedValue(undefined);
    mocks.buildDropTableSql.mockResolvedValue('DROP TABLE "APP"."ORDERS";');
    mocks.buildEmptyTableSql.mockResolvedValue('DELETE FROM "APP"."ORDERS";');
    mocks.buildTruncateTableSql.mockResolvedValue('TRUNCATE TABLE "APP"."ORDERS";');
  });

  it.each(actions)("executes $action with an empty database context", async ({ action, builder, sql }) => {
    const { feature, node } = runtime("");

    await feature[action]();

    expect(mocks.ensureConnected).toHaveBeenCalledOnce();
    expect(mocks.ensureConnected).toHaveBeenCalledWith("hana-1");
    expect(builder).toHaveBeenCalledOnce();
    expect(builder).toHaveBeenCalledWith({ databaseType: "saphana", schema: "APP", tableName: "ORDERS" });
    expect(mocks.executeWithProductionGuard).toHaveBeenCalledOnce();
    expect(mocks.executeWithProductionGuard).toHaveBeenCalledWith(node, sql, {
      database: "",
      schema: "APP",
      executionId: expect.any(String),
      isCancelledBeforeDispatch: expect.any(Function),
      markDispatched: expect.any(Function),
    });
  });

  it("removes the dropped table and releases its active reference", async () => {
    const { feature, node } = runtime("");

    await feature.confirmDropTable();

    expect(mocks.closeDroppedTableObjectTabsForNode).toHaveBeenCalledWith(node);
    expect(mocks.removeTreeNode).toHaveBeenCalledWith(node.id);
    expect(mocks.releaseActiveNodeReference).toHaveBeenCalledWith([node.id]);
  });

  it.each(["confirmEmptyTable", "confirmTruncateTable"] as const)("refreshes data tabs after %s", async (action) => {
    const { feature, node } = runtime("");

    await feature[action]();

    expect(mocks.refreshMutatedTableDataTabsForNode).toHaveBeenCalledWith(node);
  });

  it.each(actions)("preserves $action for a non-empty database context", async ({ action, sql }) => {
    const { feature, node } = runtime("TENANT");

    await feature[action]();

    expect(mocks.executeWithProductionGuard).toHaveBeenCalledWith(node, sql, {
      database: "TENANT",
      schema: "APP",
      executionId: expect.any(String),
      isCancelledBeforeDispatch: expect.any(Function),
      markDispatched: expect.any(Function),
    });
  });

  it.each([null, undefined])("rejects a %s database context", async (database) => {
    for (const { action } of actions) {
      const { feature } = runtime(database);
      await feature[action]();
    }

    expect(mocks.ensureConnected).not.toHaveBeenCalled();
    expect(mocks.buildDropTableSql).not.toHaveBeenCalled();
    expect(mocks.buildEmptyTableSql).not.toHaveBeenCalled();
    expect(mocks.buildTruncateTableSql).not.toHaveBeenCalled();
    expect(mocks.executeWithProductionGuard).not.toHaveBeenCalled();
  });

  it("reports SQL generation failures without dropping local state", async () => {
    const { feature } = runtime("");
    mocks.buildDropTableSql.mockRejectedValueOnce(new Error("generation failed"));

    await feature.confirmDropTable();

    expect(mocks.executeWithProductionGuard).not.toHaveBeenCalled();
    expect(mocks.closeDroppedTableObjectTabsForNode).not.toHaveBeenCalled();
    expect(mocks.removeTreeNode).not.toHaveBeenCalled();
    expect(mocks.releaseActiveNodeReference).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("contextMenu.tableOperationFailed", 5000);
  });

  it("reports execution failures without refreshing data tabs", async () => {
    const { feature } = runtime("");
    mocks.executeWithProductionGuard.mockRejectedValueOnce(new Error("execution failed"));

    await feature.confirmTruncateTable();

    expect(mocks.refreshMutatedTableDataTabsForNode).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("contextMenu.tableOperationFailed", 5000);
  });

  it("registers a running-execution cancel handler while empty table is in flight, and clears it afterward", async () => {
    const { feature } = runtime("");
    mocks.executeWithProductionGuard.mockImplementationOnce(async () => {
      expect(sidebarDangerRunningExecutionId.value).not.toBe("");
      expect(sidebarDangerRunningCancel.value).toBeTypeOf("function");
    });

    await feature.confirmEmptyTable();

    expect(sidebarDangerRunningExecutionId.value).toBe("");
    expect(sidebarDangerRunningCancel.value).toBeNull();
  });

  it("shows a timed-out (not failed) toast when the query is still running server-side, and keeps the cancel handle alive", async () => {
    const { feature } = runtime("");
    mocks.executeWithProductionGuard.mockImplementationOnce(async (_node: unknown, _sql: unknown, options: { markDispatched: () => void }) => {
      options.markDispatched();
      throw new Error("Query timed out after 60 seconds");
    });

    await feature.confirmEmptyTable();

    expect(mocks.toast).toHaveBeenCalledWith("contextMenu.tableOperationTimedOut", 8000);
    expect(mocks.toast).not.toHaveBeenCalledWith("contextMenu.tableOperationFailed", 5000);
    // A client-observed timeout must not remove the user's ability to cancel
    // — the underlying operation may still be running on the database.
    expect(sidebarDangerRunningExecutionId.value).not.toBe("");
    expect(sidebarDangerRunningCancel.value).toBeTypeOf("function");
  });

  it("classifies a JDBC-agent-routed timeout (SAP HANA/Oracle/DB2/SQL Server) as timed-out, not failed, even though its message has no timeout wording", async () => {
    const { feature } = runtime("");
    // AgentCallError::Timeout carries no `detail` (crates/dbx-core/src/backend_error.rs),
    // so BackendErrorException.message degrades to a generic fallback with no
    // "timed out" text — only the structured backendError distinguishes it.
    const agentTimeoutError = {
      name: "BackendErrorException",
      message: "Backend request failed",
      backendError: {
        version: 1,
        code: "DBX-JDBC-2001",
        messageKey: "backendErrors.jdbc.operationTimedOut",
        messageParams: { stage: "execute" },
        source: "jdbcAgent",
        operationOutcome: "unknown",
      },
    };
    mocks.executeWithProductionGuard.mockImplementationOnce(async (_node: unknown, _sql: unknown, options: { markDispatched: () => void }) => {
      options.markDispatched();
      throw agentTimeoutError;
    });

    await feature.confirmEmptyTable();

    expect(mocks.toast).toHaveBeenCalledWith("contextMenu.tableOperationTimedOut", 8000);
    expect(mocks.toast).not.toHaveBeenCalledWith("contextMenu.tableOperationFailed", 5000);
    // The cancel entry point must stay live for this database family too.
    expect(sidebarDangerRunningExecutionId.value).not.toBe("");
    expect(sidebarDangerRunningCancel.value).toBeTypeOf("function");
  });

  it("shows a cancelled toast when the user explicitly cancels the running query", async () => {
    const { feature } = runtime("");
    mocks.cancelQuery.mockResolvedValueOnce(true);
    mocks.executeWithProductionGuard.mockImplementationOnce(async (_node: unknown, _sql: unknown, options: { markDispatched: () => void }) => {
      options.markDispatched();
      await sidebarDangerRunningCancel.value?.();
      throw new Error("Query timed out after 60 seconds");
    });

    await feature.confirmEmptyTable();

    expect(mocks.cancelQuery).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith("contextMenu.tableOperationCancelled", 3000);
    expect(mocks.toast).not.toHaveBeenCalledWith("contextMenu.tableOperationTimedOut", 8000);
    expect(mocks.toast).not.toHaveBeenCalledWith("contextMenu.tableOperationFailed", 5000);
    expect(sidebarDangerRunningExecutionId.value).toBe("");
    expect(sidebarDangerRunningCancel.value).toBeNull();
  });

  it("waits for an in-flight cancel confirmation before classifying a cancelled execution", async () => {
    const { feature } = runtime("");
    let signalCancelStarted: () => void = () => {};
    let resolveCancel: (confirmed: boolean) => void = () => {};
    const cancelStarted = new Promise<void>((resolve) => {
      signalCancelStarted = resolve;
    });
    const cancelResult = new Promise<boolean>((resolve) => {
      resolveCancel = resolve;
    });
    mocks.cancelQuery.mockImplementationOnce(() => {
      signalCancelStarted();
      return cancelResult;
    });
    mocks.executeWithProductionGuard.mockImplementationOnce(async (_node: unknown, _sql: unknown, options: { markDispatched: () => void }) => {
      options.markDispatched();
      void sidebarDangerRunningCancel.value?.();
      throw new Error("Query cancelled");
    });

    const operationPromise = feature.confirmEmptyTable();
    await cancelStarted;

    expect(mocks.toast).not.toHaveBeenCalledWith("contextMenu.tableOperationCancelUnconfirmed", 8000);
    resolveCancel(true);
    await operationPromise;

    expect(mocks.toast).toHaveBeenCalledWith("contextMenu.tableOperationCancelled", 3000);
    expect(mocks.toast).not.toHaveBeenCalledWith("contextMenu.tableOperationCancelUnconfirmed", 8000);
    expect(mocks.toast).not.toHaveBeenCalledWith("contextMenu.tableOperationCancelPending", 6000);
    expect(sidebarDangerRunningExecutionId.value).toBe("");
    expect(sidebarDangerRunningCancel.value).toBeNull();
  });

  it("never dispatches the SQL when the user cancels before the operation is sent to the database (registration race)", async () => {
    const { feature } = runtime("");
    mocks.ensureConnected.mockImplementationOnce(async () => {
      // The user clicks Cancel Query while we're still waiting on the
      // connection — well before the backend has any executionId to
      // register, let alone cancel.
      await sidebarDangerRunningCancel.value?.();
    });

    await feature.confirmEmptyTable();

    expect(mocks.executeWithProductionGuard).not.toHaveBeenCalled();
    expect(mocks.cancelQuery).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("contextMenu.tableOperationCancelled", 3000);
    expect(mocks.toast).not.toHaveBeenCalledWith("contextMenu.tableOperationFailed", 5000);
    expect(sidebarDangerRunningExecutionId.value).toBe("");
    expect(sidebarDangerRunningCancel.value).toBeNull();
  });

  it("does not report a false 'cancelled' outcome when the backend never confirms the cancel", async () => {
    const { feature } = runtime("");
    mocks.cancelQuery.mockResolvedValue(false);
    mocks.executeWithProductionGuard.mockImplementationOnce(async (_node: unknown, _sql: unknown, options: { markDispatched: () => void }) => {
      options.markDispatched();
      await sidebarDangerRunningCancel.value?.();
      throw new Error("some backend error unrelated to timeout");
    });

    await feature.confirmEmptyTable();

    // Bounded retry, not a single silently-ignored attempt.
    expect(mocks.cancelQuery.mock.calls.length).toBeGreaterThan(1);
    // The cancel handler itself surfaces feedback the moment its own
    // confirmation window gives up (before the underlying operation later
    // settles and reports tableOperationCancelUnconfirmed).
    expect(mocks.toast).toHaveBeenCalledWith("contextMenu.tableOperationCancelPending", 6000);
    expect(mocks.toast).toHaveBeenCalledWith("contextMenu.tableOperationCancelUnconfirmed", 8000);
    expect(mocks.toast).not.toHaveBeenCalledWith("contextMenu.tableOperationCancelled", 3000);
    expect(mocks.toast).not.toHaveBeenCalledWith("contextMenu.tableOperationFailed", 5000);
    expect(sidebarDangerRunningExecutionId.value).toBe("");
  });

  it("lets a cancel confirmed after a timeout finish closing out the running execution", async () => {
    const { feature } = runtime("");
    mocks.executeWithProductionGuard.mockImplementationOnce(async (_node: unknown, _sql: unknown, options: { markDispatched: () => void }) => {
      options.markDispatched();
      throw new Error("Query timed out after 60 seconds");
    });

    await feature.confirmEmptyTable();
    expect(sidebarDangerRunningExecutionId.value).not.toBe("");
    mocks.toast.mockClear();

    // The dialog's Cancel Query button is still wired to the same handle;
    // the user clicks it after the timeout and the backend now confirms it.
    mocks.cancelQuery.mockResolvedValueOnce(true);
    await sidebarDangerRunningCancel.value?.();

    expect(mocks.toast).toHaveBeenCalledWith("contextMenu.tableOperationCancelled", 3000);
    expect(sidebarDangerRunningExecutionId.value).toBe("");
    expect(sidebarDangerRunningCancel.value).toBeNull();
  });

  it("does not let the cancel handle hang forever if cancelQuery itself never resolves", async () => {
    const { feature } = runtime("");
    mocks.executeWithProductionGuard.mockImplementationOnce(async (_node: unknown, _sql: unknown, options: { markDispatched: () => void }) => {
      options.markDispatched();
      throw new Error("Query timed out after 60 seconds");
    });

    await feature.confirmEmptyTable();
    expect(sidebarDangerRunningExecutionId.value).not.toBe("");

    vi.useFakeTimers();
    try {
      // A wedged connection: cancelQuery never settles at all.
      mocks.cancelQuery.mockImplementation(() => new Promise(() => {}));
      const cancelPromise = sidebarDangerRunningCancel.value?.();
      // CANCEL_QUERY_OVERALL_TIMEOUT_MS is 10s; advance past it.
      await vi.advanceTimersByTimeAsync(11_000);
      await cancelPromise;
    } finally {
      vi.useRealTimers();
    }

    // A single hung attempt must not block the remaining retries — each
    // attempt gets its own bounded slice of the overall retry budget.
    expect(mocks.cancelQuery.mock.calls.length).toBeGreaterThan(1);
    // The closure above must have settled instead of hanging — a stuck
    // cancel handle would otherwise permanently disable the shared
    // sidebarDangerDialogCancelling state for every future danger dialog.
    expect(mocks.toast).not.toHaveBeenCalledWith("contextMenu.tableOperationCancelled", 3000);
    // Settling silently is not enough on its own: the user must be told the
    // cancel could not be confirmed instead of the button just going quiet.
    expect(mocks.toast).toHaveBeenCalledWith("contextMenu.tableOperationCancelPending", 6000);
    // The operation may genuinely still be running server-side, so the
    // running-execution state must not be torn down just because the
    // confirmation window elapsed.
    expect(sidebarDangerRunningExecutionId.value).not.toBe("");
  });

  it("confirms the cancel when the first backend response arrives after its own per-attempt timeout", async () => {
    const { feature } = runtime("");
    mocks.executeWithProductionGuard.mockImplementationOnce(async (_node: unknown, _sql: unknown, options: { markDispatched: () => void }) => {
      options.markDispatched();
      throw new Error("Query timed out after 60 seconds");
    });

    await feature.confirmEmptyTable();
    mocks.toast.mockClear();

    vi.useFakeTimers();
    try {
      let resolveFirstAttempt: (confirmed: boolean) => void = () => {};
      const firstAttempt = new Promise<boolean>((resolve) => {
        resolveFirstAttempt = resolve;
      });
      mocks.cancelQuery.mockImplementationOnce(() => firstAttempt);
      // By the time a retry is fired, the backend has already removed the
      // execution id (the first attempt is the one that actually cancelled
      // it), so any further attempt can only ever answer false.
      mocks.cancelQuery.mockResolvedValue(false);

      const cancelPromise = sidebarDangerRunningCancel.value?.();
      // Let the first attempt's own 2s per-attempt timeout elapse without an
      // answer, so the loop moves on to firing a retry.
      await vi.advanceTimersByTimeAsync(2_000);
      // The first attempt now succeeds, 0.5s after its own timeout fired —
      // it must still be observed instead of being discarded.
      resolveFirstAttempt(true);
      await vi.advanceTimersByTimeAsync(500);
      await cancelPromise;
    } finally {
      vi.useRealTimers();
    }

    expect(mocks.toast).toHaveBeenCalledWith("contextMenu.tableOperationCancelled", 3000);
    expect(sidebarDangerRunningExecutionId.value).toBe("");
  });

  it.each(actions)("does not report a false success for $action when the user declines the production-safety confirmation", async ({ action }) => {
    const { feature } = runtime("");
    mocks.executeWithProductionGuard.mockResolvedValueOnce(undefined);

    await feature[action]();

    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.closeDroppedTableObjectTabsForNode).not.toHaveBeenCalled();
    expect(mocks.removeTreeNode).not.toHaveBeenCalled();
    expect(mocks.releaseActiveNodeReference).not.toHaveBeenCalled();
    expect(mocks.refreshMutatedTableDataTabsForNode).not.toHaveBeenCalled();
    expect(sidebarDangerRunningExecutionId.value).toBe("");
    expect(sidebarDangerRunningCancel.value).toBeNull();
  });
});
