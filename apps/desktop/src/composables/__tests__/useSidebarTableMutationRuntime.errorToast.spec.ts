// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import type { TreeNode } from "@/types/database";
import { useToast } from "@/composables/useToast";
import { useSidebarTableMutationRuntime } from "@/composables/useSidebarTableMutationRuntime";
import { dropTablePreviewSql, emptyTablePreviewSql, sidebarDangerRunningCancel, sidebarDangerRunningExecutionId, sidebarDangerTarget, truncateTablePreviewSql } from "@/components/sidebar/sidebarTreeDialogState";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, params?: { message?: string }) => `${key}${params?.message ? `: ${params.message}` : ""}` }) }));
vi.mock("@/lib/backend/api", () => ({ cancelQuery: vi.fn() }));

function createRuntime() {
  const node: TreeNode = { id: "pg:dbx:public:toast_parent", type: "table", label: "toast_parent", connectionId: "pg", database: "dbx", schema: "public" };
  const execute = vi.fn();
  const refresh = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn();
  const runtime = useSidebarTableMutationRuntime({
    activeNode: shallowRef(node),
    connectionStore: {
      getConfig: () => ({ id: "pg", db_type: "postgres" }),
      ensureConnected: vi.fn().mockResolvedValue(undefined),
      removeTreeNode: remove,
    } as any,
    currentDatabaseType: () => "postgres",
    databaseTypeForNode: () => "postgres",
    executeWithProductionGuard: execute,
    closeDroppedTableObjectTabsForNode: vi.fn(),
    refreshMutatedTableDataTabsForNode: refresh,
    releaseActiveNodeReference: vi.fn(),
  });
  return { runtime, execute, refresh, remove };
}

function clearNotifications() {
  const notifications = useToast();
  for (const item of notifications.persistentMessages.value) notifications.dismissToast(item.id);
  notifications.dismissToast();
}

describe("manual PostgreSQL table-operation error notifications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearNotifications();
    sidebarDangerTarget.value = null;
    sidebarDangerRunningExecutionId.value = "";
    sidebarDangerRunningCancel.value = null;
    dropTablePreviewSql.value = 'DROP TABLE "public"."toast_parent";';
    emptyTablePreviewSql.value = 'DELETE FROM "public"."toast_parent";';
    truncateTablePreviewSql.value = 'TRUNCATE TABLE "public"."toast_parent";';
  });

  afterEach(() => {
    clearNotifications();
    vi.clearAllTimers();
    vi.useRealTimers();
    sidebarDangerTarget.value = null;
    sidebarDangerRunningExecutionId.value = "";
    sidebarDangerRunningCancel.value = null;
    dropTablePreviewSql.value = "";
    emptyTablePreviewSql.value = "";
    truncateTablePreviewSql.value = "";
  });

  it.each(["confirmDropTable", "confirmEmptyTable", "confirmTruncateTable"] as const)("keeps %s errors until dismissed, even after a successful retry", async (action) => {
    const { runtime, execute, refresh, remove } = createRuntime();
    const notifications = useToast();
    const nativeMessage = 'cannot perform operation on "toast_parent" because another table depends on it';
    execute.mockRejectedValueOnce(new Error(nativeMessage));

    await runtime[action]();

    expect(execute).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(sidebarDangerRunningExecutionId.value).toBe("");
    expect(notifications.persistentMessages.value).toHaveLength(1);
    const failure = notifications.persistentMessages.value[0]!;
    expect(failure.message).toContain(nativeMessage);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notifications.persistentMessages.value).toEqual([failure]);

    execute.mockResolvedValueOnce({});
    await runtime[action]();
    expect(notifications.visible.value).toBe(true);
    expect(notifications.message.value).toContain("Success");
    expect(notifications.persistentMessages.value).toEqual([failure]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(notifications.visible.value).toBe(false);
    expect(notifications.persistentMessages.value).toEqual([failure]);

    notifications.dismissToast(failure.id);
    expect(notifications.persistentMessages.value).toEqual([]);
  });
});
