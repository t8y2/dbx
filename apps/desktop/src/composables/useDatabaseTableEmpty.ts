import { ref, shallowRef } from "vue";
import { notifyDatabaseBrowserMutation } from "@/lib/database/databaseBrowserActions";
import { useI18n } from "vue-i18n";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import * as api from "@/lib/backend/api";
import { connectionObjectTreeNodeSchema } from "@/lib/database/jdbcDialect";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { translateBackendError } from "@/i18n/backend-errors";
import { getTableMutationHistoryStoreOrNull, recordTableMutationHistory } from "@/lib/history/tableMutationHistory";
import { runBatchTableEmptyLayers, type BatchTableEmptyPlanItem } from "@/lib/sidebar/batchTableEmpty";
import { buildDatabaseTableEmptyPlanLayers, buildMysqlTableMutationSql, DatabaseTableEmptyPlanError, type DatabaseEmptyTable } from "@/lib/sidebar/databaseTableEmpty";
import { createSidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";
import { uuid } from "@/lib/common/utils";
import type { SidebarDangerDialogRequest } from "@/lib/sidebar/sidebarDangerDialog";
import type { ConnectionConfig, TreeNode } from "@/types/database";

export function canEmptyDatabaseTables(node: TreeNode, connection?: ConnectionConfig): boolean {
  const profile = connection?.driver_profile?.toLowerCase();
  const unsupportedMysqlProfiles = ["doris", "selectdb", "starrocks", "manticoresearch"];
  return (
    node.type === "database" &&
    !!node.database &&
    !!node.connectionId &&
    connection?.db_type === "mysql" &&
    !unsupportedMysqlProfiles.includes(profile ?? "") &&
    !connectionIsEffectivelyReadOnly(connection) &&
    !["mysql", "sys", "information_schema", "performance_schema", "ndbinfo"].includes(node.database.toLowerCase())
  );
}
export const canDropDatabaseTables = canEmptyDatabaseTables;

export function useDatabaseTableEmpty(openDialog: (request: SidebarDangerDialogRequest) => void) {
  const { t } = useI18n();
  const { toast } = useToast();
  const connections = useConnectionStore();
  const queries = useQueryStore();
  async function requestDatabaseTables(node: TreeNode, operation: "empty" | "drop") {
    const target = createSidebarActionTarget(node);
    const connectionId = target.connectionId!;
    const database = target.database!;
    if (!canEmptyDatabaseTables(target, connections.getConfig(connectionId))) return;
    const typedName = ref("");
    const loading = ref(true);
    const executing = ref(false);
    const finished = ref(false);
    const cancelled = ref(false);
    const details = ref("");
    const completed = ref(0);
    const preparing = ref(0);
    const preparingTotal = ref(0);
    const plan = shallowRef<BatchTableEmptyPlanItem<DatabaseEmptyTable>[]>([]);
    const layers = shallowRef<{ items: BatchTableEmptyPlanItem<DatabaseEmptyTable>[]; dependencies?: Record<string, string[]> }[]>([]);
    const activeExecutionIds = new Set<string>();
    const preparationExecutionIds = new Set<string>();
    const connectionName = connections.getConfig(connectionId)?.name ?? connectionId;
    const fullSql = () => plan.value.map(({ sql }) => sql).join("\n");
    const previewSql = () => {
      const preview = plan.value
        .slice(0, 100)
        .map(({ sql }) => sql)
        .join("\n");
      return plan.value.length > 100 ? `${preview}\n-- ${plan.value.length - 100} more statements` : preview;
    };
    const request: SidebarDangerDialogRequest = {
      target,
      title: t(operation === "empty" ? "databaseEmpty.title" : "databaseDrop.title"),
      get message() {
        if (loading.value && plan.value.length === 0) return `${t(operation === "empty" ? "databaseEmpty.preparing" : "databaseDrop.preparing", { database })} ${preparingTotal.value ? `${preparing.value} / ${preparingTotal.value}` : ""}`;
        return t(operation === "empty" ? "databaseEmpty.message" : "databaseDrop.message", { connection: connectionName, database, count: plan.value.length });
      },
      get sql() {
        return previewSql();
      },
      copySql: fullSql,
      get detailsText() {
        return details.value;
      },
      get loading() {
        return loading.value;
      },
      get confirmDisabled() {
        return loading.value || finished.value || cancelled.value || !plan.value.length || typedName.value !== database;
      },
      confirmLabel: t(operation === "empty" ? "databaseEmpty.title" : "databaseDrop.title"),
      closeOnConfirm: false,
      get progress() {
        return executing.value && plan.value.length ? { completed: completed.value, total: plan.value.length, phase: "executing" as const } : loading.value && preparingTotal.value ? { completed: preparing.value, total: preparingTotal.value, phase: "preparing" as const } : undefined;
      },
      async cancelRunning() {
        cancelled.value = true;
        await Promise.all([...activeExecutionIds, ...preparationExecutionIds].map((id) => api.cancelQuery(id).catch(() => false)));
      },
      textInput: {
        value: "",
        label: t(operation === "empty" ? "databaseEmpty.typeName" : "databaseDrop.typeName", { database }),
        placeholder: database,
        onInput(value) {
          typedName.value = value;
        },
      },
      async confirm() {
        if (request.confirmDisabled) return false;
        loading.value = true;
        executing.value = true;
        const frozenPlan = plan.value;
        const reviewSql = previewSql();
        const start = Date.now();
        try {
          const result = await executeWithProductionSqlGuard({
            connection: connections.getConfig(connectionId),
            database,
            sql: reviewSql,
            source: t("production.sourceSidebar"),
            execute: () =>
              runBatchTableEmptyLayers(layers.value, {
                concurrency: 8,
                isCancelled: () => cancelled.value,
                keyOf: (table) => table.name,
                execute: async (item, executionId) => {
                  activeExecutionIds.add(executionId);
                  try {
                    const response = await api.executeQuery(connectionId, database, item.sql, database, executionId);
                    if (response.execution_error) throw new Error(String(response.rows[0]?.[0] ?? "Statement failed"));
                  } finally {
                    activeExecutionIds.delete(executionId);
                  }
                },
                onProgress: (value) => {
                  completed.value = value;
                },
              }),
          });
          if (!result) return false;
          finished.value = true;
          const failures = result.failed.map(({ target: item, error }) => `${item.name}: ${translateBackendError(t, error)}`);
          const cancelledCount = result.cancelled?.length ?? 0;
          const skippedCount = result.skipped?.length ?? 0;
          const skippedDetails = (result.skipped ?? []).slice(0, 100).map(({ target: item, reason, dependency }) => (dependency ? t(`${operation === "empty" ? "databaseEmpty" : "databaseDrop"}.blockedBy`, { table: item.name, dependency }) : `${item.name}: ${reason}`));
          const omittedFailures = failures.length > 100 ? [`... ${failures.length - 100} more failures`] : [];
          const omittedSkipped = skippedCount > 100 ? [`... ${skippedCount - 100} more skipped tables`] : [];
          details.value = [
            t(operation === "empty" ? "databaseEmpty.result" : "databaseDrop.result", { success: result.succeeded.length, failed: result.failed.length }),
            skippedCount ? t(operation === "empty" ? "databaseEmpty.skipped" : "databaseDrop.skipped", { count: skippedCount }) : "",
            ...skippedDetails,
            ...omittedSkipped,
            cancelledCount ? t(operation === "empty" ? "databaseEmpty.cancelled" : "databaseDrop.cancelled", { count: cancelledCount }) : "",
            ...failures.slice(0, 100),
            ...omittedFailures,
          ]
            .filter(Boolean)
            .join("\n");
          toast(details.value, result.failed.length || cancelledCount || skippedCount ? 5000 : 3000);
          const historyTarget =
            frozenPlan.length > 100
              ? `${frozenPlan
                  .slice(0, 100)
                  .map(({ target: table }) => table.name)
                  .join(", ")}, +${frozenPlan.length - 100} more`
              : frozenPlan.map(({ target: table }) => table.name).join(", ");
          const historyError = failures.length > 100 ? `${failures.slice(0, 100).join("; ")}; +${failures.length - 100} more failures` : failures.join("; ");
          await recordTableMutationHistory(getTableMutationHistoryStoreOrNull(), {
            connectionId,
            connectionName,
            database,
            sql: reviewSql,
            elapsedMs: Date.now() - start,
            success: result.failed.length === 0 && cancelledCount === 0 && skippedCount === 0,
            error: historyError || undefined,
            target: historyTarget,
          }).catch((error) => console.warn("[DBX] failed to record database empty history", error));
          const complete = result.failed.length === 0 && cancelledCount === 0 && skippedCount === 0;
          if (result.succeeded.length) {
            const schema = connectionObjectTreeNodeSchema(connections.getConfig(connectionId), database, database);
            for (const table of result.succeeded) {
              if (operation === "drop") queries.closeDroppedTableObjectTabs({ connectionId, database, schema, schemaCandidates: [database, schema], name: table.name, objectType: "TABLE" });
              if (operation === "empty") await queries.refreshDataTabsForTable({ connectionId, database, schema, schemaCandidates: [database, schema], catalog: target.catalog, name: table.name }).catch((error) => console.warn("[DBX] failed to refresh emptied table", error));
            }
            await connections.refreshObjectListTreeNode(connectionId, database, undefined, target.catalog).catch((error) => {
              details.value += `\n${t("databaseEmpty.refreshFailed", { message: translateBackendError(t, error) })}`;
            });
            notifyDatabaseBrowserMutation({ connectionId, database, operation: operation === "empty" ? "empty" : "drop-tables" });
          }
          return complete;
        } catch (error) {
          details.value = translateBackendError(t, error);
          toast(t("contextMenu.tableOperationFailed", { message: details.value }), 5000);
          return false;
        } finally {
          loading.value = false;
          executing.value = false;
        }
      },
    };
    openDialog(request);
    const ensurePreparationActive = () => {
      if (cancelled.value) throw new DatabaseTableEmptyPlanError("cancelled", []);
    };
    const runPreparationRequest = async <T>(request: (executionId: string) => Promise<T>): Promise<T> => {
      ensurePreparationActive();
      const executionId = uuid();
      preparationExecutionIds.add(executionId);
      try {
        const result = await request(executionId);
        ensurePreparationActive();
        return result;
      } catch (error) {
        if (cancelled.value) throw new DatabaseTableEmptyPlanError("cancelled", []);
        throw error;
      } finally {
        preparationExecutionIds.delete(executionId);
      }
    };
    try {
      await connections.ensureConnected(connectionId);
      const externalReferences = await runPreparationRequest((executionId) =>
        api.executeQuery(connectionId, database, "SELECT TABLE_SCHEMA, TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA = DATABASE() AND TABLE_SCHEMA <> DATABASE() LIMIT 1", undefined, executionId),
      );
      if (externalReferences.execution_error) throw new Error(t("databaseEmpty.metadataFailed"));
      if (externalReferences.rows.length) throw new Error(t("databaseEmpty.externalReferences"));
      const foreignKeysByTable = await runPreparationRequest((executionId) => api.listForeignKeysForDatabase(connectionId, database, database, target.catalog, executionId));
      layers.value = await buildDatabaseTableEmptyPlanLayers({
        database,
        listTables: () => runPreparationRequest((executionId) => api.listObjects(connectionId, database, database, ["TABLE"], undefined, undefined, undefined, target.catalog, undefined, executionId)),
        foreignKeysByTable,
        isCancelled: () => cancelled.value,
        onProgress: (value, total) => {
          preparing.value = value;
          preparingTotal.value = total * 2;
        },
        onSqlProgress: (value, total) => {
          preparing.value = total + value;
          preparingTotal.value = total * 2;
        },
        buildSql: async (table) => buildMysqlTableMutationSql(operation, database, table.name),
      });
      plan.value = layers.value.flatMap((layer) => layer.items);
      if (!plan.value.length) details.value = t(operation === "empty" ? "databaseEmpty.noTables" : "databaseDrop.noTables");
      else if (plan.value.length > 2000) details.value = t(operation === "empty" ? "databaseEmpty.veryLargeWarning" : "databaseDrop.veryLargeWarning", { count: plan.value.length });
      else if (plan.value.length > 500) details.value = t(operation === "empty" ? "databaseEmpty.largeWarning" : "databaseDrop.largeWarning", { count: plan.value.length });
    } catch (error) {
      details.value =
        error instanceof DatabaseTableEmptyPlanError && error.reason === "cancelled"
          ? t(`${operation === "empty" ? "databaseEmpty" : "databaseDrop"}.cancelledPreparation`)
          : error instanceof DatabaseTableEmptyPlanError
            ? t(`${operation === "empty" ? "databaseEmpty" : "databaseDrop"}.${error.reason}`, { tables: error.tables.join(", ") })
            : translateBackendError(t, error);
    } finally {
      loading.value = false;
    }
  }
  return { requestEmptyDatabaseTables: (node: TreeNode) => requestDatabaseTables(node, "empty"), requestDropDatabaseTables: (node: TreeNode) => requestDatabaseTables(node, "drop") };
}
