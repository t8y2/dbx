import { computed, type ShallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import type { DatabaseType, TreeNode } from "@/types/database";
import { supportsTableTruncate, supportsTableVacuum } from "@/lib/database/databaseCapabilities";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import {
  buildDropTableSql,
  buildEmptyTableSql,
  buildMysqlAutoIncrementSql,
  buildTruncateTableSql,
  buildVacuumTableSql,
  supportsDropTableCascade,
  supportsNativeMysqlAutoIncrement,
  supportsTruncateTableCascade,
  type MysqlAutoIncrementSqlOptions,
  type TableAdminSqlOptions,
  type VacuumTableSqlOptions,
} from "@/lib/database/dbAdminSql";
import { isSqlServerLinkedNode } from "@/lib/database/sqlServerLinkedServers";
import { isQueryTimeoutErrorMessage } from "@/lib/sql/queryError";
import { uuid } from "@/lib/common/utils";
import * as api from "@/lib/backend/api";
import { normalizeBackendError, type BackendError } from "@/lib/backend/errorUtils";
import {
  sidebarDangerTarget,
  sidebarDangerRunningExecutionId,
  sidebarDangerRunningCancel,
  showDropTableConfirm,
  showEmptyTableConfirm,
  showMysqlAutoIncrementConfirm,
  showTruncateTableConfirm,
  showVacuumTableConfirm,
  dropTablePreviewSql,
  dropTableCascade,
  emptyTablePreviewSql,
  mysqlAutoIncrementPreviewKey,
  mysqlAutoIncrementPreviewSql,
  mysqlAutoIncrementValue,
  truncateTablePreviewSql,
  truncateTableCascade,
  vacuumTableFull,
  vacuumTableAnalyze,
  vacuumTablePreviewSql,
  vacuumTablePreviewKey,
  vacuumTableExecuting,
} from "@/components/sidebar/sidebarTreeDialogState";

interface SidebarTableMutationRuntimeOptions {
  activeNode: ShallowRef<TreeNode>;
  releaseActiveNodeReference: (nodeIds: readonly string[]) => void;
  connectionStore: ReturnType<typeof useConnectionStore>;
  currentDatabaseType: () => DatabaseType | undefined;
  databaseTypeForNode: (node: TreeNode) => DatabaseType | undefined;
  executeWithProductionGuard: (node: Pick<TreeNode, "connectionId" | "database" | "schema">, sql: string, options?: { database?: string; schema?: string; executionId?: string; isCancelledBeforeDispatch?: () => boolean; markDispatched?: () => void }) => Promise<unknown>;
  closeDroppedTableObjectTabsForNode: (node: TreeNode) => void;
  refreshMutatedTableDataTabsForNode: (node: TreeNode) => Promise<void>;
}

export function useSidebarTableMutationRuntime(options: SidebarTableMutationRuntimeOptions) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { activeNode, connectionStore, currentDatabaseType, databaseTypeForNode } = options;

  const isTableNotView = computed(() => activeNode.value.type === "table" && !isSqlServerLinkedNode(activeNode.value));
  const supportsTruncate = computed(() => supportsTableTruncate(currentDatabaseType()));
  const supportsVacuum = computed(() => {
    const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
    return activeNode.value.type === "table" && !connectionIsEffectivelyReadOnly(config) && supportsTableVacuum(currentDatabaseType());
  });
  const canDropTableCascade = computed(() => activeNode.value.type === "table" && supportsDropTableCascade(currentDatabaseType()));
  const canTruncateTableCascade = computed(() => activeNode.value.type === "table" && supportsTruncateTableCascade(currentDatabaseType()));
  const supportsMysqlAutoIncrement = computed(() => activeNode.value.type === "table" && supportsNativeMysqlAutoIncrement(activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined));

  function tableAdminSqlOptions(optionsOverride?: { cascade?: boolean }): TableAdminSqlOptions {
    const result: TableAdminSqlOptions = {
      databaseType: currentDatabaseType(),
      schema: activeNode.value.schema,
      tableName: activeNode.value.label,
      // Cloud Spanner's two dialects quote differently, so admin SQL needs the quote the connected
      // agent reported rather than the static per-type mapping.
      identifierQuote: connectionStore.connectionIdentifierQuote?.(activeNode.value.connectionId),
    };
    if (optionsOverride?.cascade) result.cascade = true;
    return result;
  }

  function tableAdminSqlOptionsForNode(node: TreeNode, optionsOverride?: { cascade?: boolean }): TableAdminSqlOptions {
    const result: TableAdminSqlOptions = {
      databaseType: databaseTypeForNode(node),
      schema: node.schema,
      tableName: node.label,
      identifierQuote: connectionStore.connectionIdentifierQuote?.(node.connectionId),
    };
    if (optionsOverride?.cascade) result.cascade = true;
    return result;
  }

  function dropTableSqlOptions(): TableAdminSqlOptions {
    return tableAdminSqlOptions({ cascade: canDropTableCascade.value && dropTableCascade.value });
  }

  function truncateTableSqlOptions(): TableAdminSqlOptions {
    return tableAdminSqlOptions({ cascade: canTruncateTableCascade.value && truncateTableCascade.value });
  }

  async function refreshDropTablePreviewSql() {
    dropTablePreviewSql.value = "";
    dropTablePreviewSql.value = await buildDropTableSql(dropTableSqlOptions()).catch(() => "");
  }

  async function refreshEmptyTablePreviewSql() {
    emptyTablePreviewSql.value = "";
    emptyTablePreviewSql.value = await buildEmptyTableSql(tableAdminSqlOptions()).catch(() => "");
  }

  async function refreshTruncateTablePreviewSql() {
    truncateTablePreviewSql.value = "";
    truncateTablePreviewSql.value = await buildTruncateTableSql(truncateTableSqlOptions()).catch(() => "");
  }

  function mysqlAutoIncrementSqlOptionsForNode(node: TreeNode): MysqlAutoIncrementSqlOptions {
    const config = node.connectionId ? connectionStore.getConfig(node.connectionId) : undefined;
    return {
      databaseType: config?.db_type ?? databaseTypeForNode(node) ?? "mysql",
      driverProfile: config?.driver_profile,
      schema: node.database || node.schema,
      tableName: node.label,
      value: mysqlAutoIncrementValue.value,
    };
  }

  function mysqlAutoIncrementPreviewKeyForNode(node: TreeNode, sqlOptions = mysqlAutoIncrementSqlOptionsForNode(node)): string {
    return JSON.stringify([node.id, node.connectionId, node.database, sqlOptions.databaseType, sqlOptions.driverProfile?.trim().toLowerCase() || "", sqlOptions.schema || "", sqlOptions.tableName, sqlOptions.value]);
  }

  async function refreshMysqlAutoIncrementPreviewSql() {
    const node = activeNode.value;
    const sqlOptions = mysqlAutoIncrementSqlOptionsForNode(node);
    const previewKey = mysqlAutoIncrementPreviewKeyForNode(node, sqlOptions);
    mysqlAutoIncrementPreviewSql.value = "";
    mysqlAutoIncrementPreviewKey.value = "";
    const sql = await buildMysqlAutoIncrementSql(sqlOptions).catch(() => "");
    if (previewKey !== mysqlAutoIncrementPreviewKeyForNode(activeNode.value)) return;
    mysqlAutoIncrementPreviewSql.value = sql;
    mysqlAutoIncrementPreviewKey.value = sql ? previewKey : "";
  }

  function mysqlAutoIncrement() {
    if (!supportsMysqlAutoIncrement.value) return;
    mysqlAutoIncrementValue.value = "1";
    mysqlAutoIncrementPreviewKey.value = "";
    void refreshMysqlAutoIncrementPreviewSql();
    showMysqlAutoIncrementConfirm.value = true;
  }

  async function confirmMysqlAutoIncrement() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    if (!node.connectionId || !node.database) return;
    try {
      const config = connectionStore.getConfig(node.connectionId);
      if (!supportsNativeMysqlAutoIncrement(config)) throw new Error("Setting AUTO_INCREMENT is supported only for native MySQL connections.");
      await connectionStore.ensureConnected(node.connectionId);
      const sqlOptions = mysqlAutoIncrementSqlOptionsForNode(node);
      const previewKey = mysqlAutoIncrementPreviewKeyForNode(node, sqlOptions);
      const sql = mysqlAutoIncrementPreviewKey.value === previewKey && mysqlAutoIncrementPreviewSql.value ? mysqlAutoIncrementPreviewSql.value : await buildMysqlAutoIncrementSql(sqlOptions);
      await options.executeWithProductionGuard(node, sql, { database: node.database, schema: node.schema });
      toast(t("contextMenu.mysqlAutoIncrementSuccess", { name: node.label, value: mysqlAutoIncrementValue.value }), 3000);
      await options.refreshMutatedTableDataTabsForNode(node);
    } catch (error: any) {
      toast(t("contextMenu.tableOperationFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  function vacuumTableSqlOptions(node: TreeNode, full = vacuumTableFull.value, analyze = vacuumTableAnalyze.value): VacuumTableSqlOptions {
    return {
      databaseType: databaseTypeForNode(node),
      schema: node.schema,
      tableName: node.label,
      full,
      analyze,
    };
  }

  function vacuumTablePreviewKeyForNode(node: TreeNode, full = vacuumTableFull.value, analyze = vacuumTableAnalyze.value): string {
    return JSON.stringify([node.id, databaseTypeForNode(node), node.schema || "", node.label, full, analyze]);
  }

  async function refreshVacuumTablePreviewSql() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    const full = vacuumTableFull.value;
    const analyze = vacuumTableAnalyze.value;
    const previewKey = vacuumTablePreviewKeyForNode(node, full, analyze);
    vacuumTablePreviewSql.value = "";
    vacuumTablePreviewKey.value = "";
    const sql = await buildVacuumTableSql(vacuumTableSqlOptions(node, full, analyze)).catch(() => "");
    const currentNode = sidebarDangerTarget.value ?? activeNode.value;
    if (previewKey !== vacuumTablePreviewKeyForNode(currentNode)) return;
    vacuumTablePreviewSql.value = sql;
    vacuumTablePreviewKey.value = sql ? previewKey : "";
  }

  function vacuumTable() {
    if (!supportsVacuum.value) return;
    vacuumTableFull.value = false;
    vacuumTableAnalyze.value = false;
    vacuumTablePreviewSql.value = "";
    vacuumTablePreviewKey.value = "";
    void refreshVacuumTablePreviewSql();
    showVacuumTableConfirm.value = true;
  }

  async function confirmVacuumTable(): Promise<boolean> {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    if (!node.connectionId || node.database == null) return false;
    vacuumTableExecuting.value = true;
    try {
      await connectionStore.ensureConnected(node.connectionId);
      const optionsForNode = vacuumTableSqlOptions(node, vacuumTableFull.value, vacuumTableAnalyze.value);
      const previewKey = vacuumTablePreviewKeyForNode(node);
      const sql = vacuumTablePreviewKey.value === previewKey && vacuumTablePreviewSql.value ? vacuumTablePreviewSql.value : await buildVacuumTableSql(optionsForNode);
      const executed = await options.executeWithProductionGuard(node, sql, { database: node.database, schema: node.schema });
      if (executed === undefined) return false;
      toast(t("contextMenu.vacuumTableSuccess", { name: node.label }), 3000);
      return true;
    } catch (error: any) {
      toast(t("contextMenu.tableOperationFailed", { message: error?.message || String(error) }), 5000);
      return false;
    } finally {
      vacuumTableExecuting.value = false;
    }
  }

  async function refreshVacuumPreviewForOptions() {
    await refreshVacuumTablePreviewSql();
  }

  function dropTable() {
    dropTableCascade.value = false;
    void refreshDropTablePreviewSql();
    showDropTableConfirm.value = true;
  }

  async function refreshTableList(node: TreeNode) {
    if (!node.connectionId || !node.database) return;
    await connectionStore.refreshObjectListTreeNode(node.connectionId, node.database, node.schema);
  }

  // Bounded, undelayed retry: register_task on the backend runs as the very
  // first statement of the execute_query command, so if cancelQuery races a
  // just-dispatched execution, a couple of retries are enough for the
  // registration to land — no artificial delay needed.
  const CANCEL_QUERY_MAX_ATTEMPTS = 5;
  // Overall cap on the whole retry sequence, mirroring queryStore.ts's
  // withCancelQueryTimeout/CANCEL_QUERY_TIMEOUT_MS for the main editor. If
  // api.cancelQuery itself hangs (e.g. a wedged connection), the retry loop
  // alone would never settle, which would permanently disable every future
  // danger dialog's Cancel Query button (sidebarDangerDialogCancelling is a
  // shared singleton — see ConnectionTree.vue).
  const CANCEL_QUERY_OVERALL_TIMEOUT_MS = 10_000;
  // Each attempt gets an even share of the overall budget, so a single hung
  // api.cancelQuery call can't block the remaining retries — it can only
  // ever stop *waiting* on that attempt, not actually abort it (neither
  // backend transport plumbs an AbortSignal through cancelQuery).
  const CANCEL_QUERY_PER_ATTEMPT_TIMEOUT_MS = Math.floor(CANCEL_QUERY_OVERALL_TIMEOUT_MS / CANCEL_QUERY_MAX_ATTEMPTS);

  async function confirmCancelWithRetry(executionId: string): Promise<boolean> {
    // Once an attempt's own per-attempt timeout elapses, the loop below
    // moves on to firing the next attempt without waiting for it — but it
    // must keep observing that attempt's eventual result instead of just
    // dropping the promise. A retry fired after the timeout hits the
    // backend *after* it already removed the execution id on a first
    // attempt that merely answered late, so every subsequent retry can only
    // ever return false; discarding the first attempt's own (eventually
    // `true`) result would make the whole call report an unconfirmed
    // cancel even though the backend did cancel it.
    let confirmed = false;
    let settledAttempts = 0;
    let totalAttempts = 0;
    let notifyNextSettle: (() => void) | undefined;

    function trackAttempt(attemptPromise: Promise<boolean>) {
      totalAttempts += 1;
      void attemptPromise.then((result) => {
        settledAttempts += 1;
        if (result) confirmed = true;
        notifyNextSettle?.();
      });
    }

    for (let attempt = 0; attempt < CANCEL_QUERY_MAX_ATTEMPTS && !confirmed; attempt++) {
      trackAttempt(api.cancelQuery(executionId).catch(() => false));
      await new Promise<void>((resolve) => {
        const timeoutId = setTimeout(resolve, CANCEL_QUERY_PER_ATTEMPT_TIMEOUT_MS);
        notifyNextSettle = () => {
          clearTimeout(timeoutId);
          resolve();
        };
      });
    }

    // All attempts have been fired; wait for any still-outstanding ones so
    // a slow-but-successful cancel is not lost just because it settled
    // after its own attempt's pacing timeout.
    while (!confirmed && settledAttempts < totalAttempts) {
      await new Promise<void>((resolve) => {
        notifyNextSettle = resolve;
      });
    }

    return confirmed;
  }

  // Races the retry loop against a UI-facing deadline, but also returns the
  // retry loop's own promise so a caller can keep observing it after the
  // race settles — otherwise a retry that is still running when the timeout
  // wins would have its eventual result silently discarded.
  function confirmCancelWithRetryAndTimeout(executionId: string): { confirmedWithinTimeout: Promise<boolean>; retryPromise: Promise<boolean> } {
    const retryPromise = confirmCancelWithRetry(executionId);
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<boolean>((resolve) => {
      timeoutId = setTimeout(() => resolve(false), CANCEL_QUERY_OVERALL_TIMEOUT_MS);
    });
    // Once the retry loop itself settles, the timeout has nothing left to
    // race against — clear it instead of leaving it to fire (and resolve an
    // already-settled promise) up to CANCEL_QUERY_OVERALL_TIMEOUT_MS later.
    void retryPromise.finally(() => clearTimeout(timeoutId));
    return { confirmedWithinTimeout: Promise.race([retryPromise, timeout]), retryPromise };
  }

  const DANGER_OPERATION_CANCELLED_BEFORE_DISPATCH_MESSAGE = "Operation cancelled before it was sent to the database.";

  interface DangerRunningExecution {
    executionId: string;
    isCancelledBeforeDispatch: () => boolean;
    markDispatched: () => void;
    wasCancelled: () => boolean;
    cancelConfirmed: () => boolean;
    waitForCancelConfirmation: () => Promise<boolean>;
    markHandedOff: () => void;
  }

  function beginDangerRunningExecution(nodeLabel: string): DangerRunningExecution {
    const executionId = uuid();
    let dispatched = false;
    let cancelledByUser = false;
    let cancelConfirmedFlag = false;
    let cancelConfirmationPromise: Promise<boolean> | null = null;
    // Set once the owning confirm*Table() call has already given up waiting
    // (a client-observed timeout) and deferred final cleanup to a later
    // confirmed cancel — see markHandedOff below.
    let handedOff = false;

    // Shared by both the immediate (raced) outcome and a later-arriving
    // retry result so a confirmed cancel is finalized exactly once, however
    // late it arrives.
    function finalizeConfirmedCancel() {
      cancelConfirmedFlag = true;
      if (handedOff && sidebarDangerRunningExecutionId.value === executionId) {
        toast(t("contextMenu.tableOperationCancelled", { name: nodeLabel }), 3000);
        endDangerRunningExecution();
      }
    }

    sidebarDangerRunningExecutionId.value = executionId;
    sidebarDangerRunningCancel.value = async () => {
      cancelledByUser = true;
      // Nothing has reached the backend yet: the pending dispatch will see
      // isCancelledBeforeDispatch() and skip the network call entirely, so
      // this is already a confirmed cancellation.
      if (!dispatched) {
        finalizeConfirmedCancel();
        return;
      }
      if (!cancelConfirmationPromise) {
        cancelConfirmationPromise = (async () => {
          const { confirmedWithinTimeout, retryPromise } = confirmCancelWithRetryAndTimeout(executionId);
          // Do not discard the losing side of the race: if the retry loop is
          // still going when the UI timeout wins below and it later succeeds,
          // still finalize the confirmed cancel instead of dropping the result.
          void retryPromise.then((eventuallyConfirmed) => {
            if (eventuallyConfirmed) finalizeConfirmedCancel();
          });
          const confirmed = await confirmedWithinTimeout;
          if (confirmed) {
            finalizeConfirmedCancel();
          } else if (sidebarDangerRunningExecutionId.value === executionId) {
            // The confirmation window elapsed with no answer from the database.
            // The operation may genuinely still be running server-side, so leave
            // sidebarDangerRunningExecutionId / the running-execution state
            // intact — the user can retry Cancel or just wait for it to settle
            // — but don't leave the Cancel button silently usable again with
            // zero explanation of what happened.
            //
            // Only surface this if the execution is still the one being tracked:
            // by the time this arrives, confirmDropTable/confirmEmptyTable/
            // confirmTruncateTable may have already resolved (success or an
            // unrelated failure) and moved on, in which case this stale warning
            // would contradict the outcome the user already saw.
            toast(t("contextMenu.tableOperationCancelPending", { name: nodeLabel }), 6000);
          }
          return confirmed;
        })();
      }
      const currentConfirmation = cancelConfirmationPromise;
      try {
        await currentConfirmation;
      } finally {
        if (cancelConfirmationPromise === currentConfirmation) {
          cancelConfirmationPromise = null;
        }
      }
    };

    return {
      executionId,
      isCancelledBeforeDispatch: () => cancelledByUser && !dispatched,
      markDispatched: () => {
        dispatched = true;
      },
      wasCancelled: () => cancelledByUser,
      cancelConfirmed: () => cancelConfirmedFlag,
      waitForCancelConfirmation: () => cancelConfirmationPromise ?? Promise.resolve(cancelConfirmedFlag),
      markHandedOff: () => {
        handedOff = true;
      },
    };
  }

  function endDangerRunningExecution() {
    sidebarDangerRunningExecutionId.value = "";
    sidebarDangerRunningCancel.value = null;
  }

  function toastDangerOperationError(name: string, message: string, wasCancelled: boolean, cancelConfirmed: boolean, backendError?: BackendError) {
    if (cancelConfirmed) {
      toast(t("contextMenu.tableOperationCancelled", { name }), 3000);
    } else if (wasCancelled) {
      toast(t("contextMenu.tableOperationCancelUnconfirmed", { name, message }), 8000);
    } else if (isQueryTimeoutErrorMessage(message, backendError)) {
      toast(t("contextMenu.tableOperationTimedOut", { name, message }), 8000);
    } else {
      toast(t("contextMenu.tableOperationFailed", { message }), 5000);
    }
  }

  interface DangerOperationConfig {
    node: TreeNode;
    buildSql: () => string | Promise<string>;
    onSuccess: (node: TreeNode) => void | Promise<void>;
  }

  async function runDangerOperation(config: DangerOperationConfig) {
    const { node, buildSql, onSuccess } = config;
    if (!node.connectionId || node.database == null) return;
    const { executionId, isCancelledBeforeDispatch, markDispatched, wasCancelled, cancelConfirmed, waitForCancelConfirmation, markHandedOff } = beginDangerRunningExecution(node.label);
    try {
      await connectionStore.ensureConnected(node.connectionId);
      const sql = await buildSql();
      if (isCancelledBeforeDispatch()) throw new Error(DANGER_OPERATION_CANCELLED_BEFORE_DISPATCH_MESSAGE);
      const executed = await options.executeWithProductionGuard(node, sql, { database: node.database, schema: node.schema, executionId, isCancelledBeforeDispatch, markDispatched });
      if (executed === undefined) {
        // The user declined the production-safety confirmation: the SQL was
        // never sent, so this must not be reported as a successful operation.
        endDangerRunningExecution();
        return;
      }
      await onSuccess(node);
      endDangerRunningExecution();
    } catch (error: any) {
      const message = error?.message || String(error);
      const backendError = normalizeBackendError(error) ?? undefined;
      const cancellationWasRequested = wasCancelled();
      const cancellationWasConfirmed = cancelConfirmed() || (cancellationWasRequested && (await waitForCancelConfirmation()));
      toastDangerOperationError(node.label, message, cancellationWasRequested, cancellationWasConfirmed, backendError);
      if (cancellationWasConfirmed || !isQueryTimeoutErrorMessage(message, backendError)) {
        endDangerRunningExecution();
      } else {
        markHandedOff();
      }
    }
  }

  async function confirmDropTable() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    await runDangerOperation({
      node,
      buildSql: () => dropTablePreviewSql.value || buildDropTableSql(tableAdminSqlOptionsForNode(node, { cascade: dropTableCascade.value && supportsDropTableCascade(databaseTypeForNode(node)) })),
      onSuccess: (node) => {
        toast(t("contextMenu.dropTableSuccess", { name: node.label }), 3000);
        options.closeDroppedTableObjectTabsForNode(node);
        connectionStore.removeTreeNode(node.id);
        options.releaseActiveNodeReference([node.id]);
      },
    });
  }

  function emptyTable() {
    void refreshEmptyTablePreviewSql();
    showEmptyTableConfirm.value = true;
  }

  async function confirmEmptyTable() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    await runDangerOperation({
      node,
      buildSql: () => emptyTablePreviewSql.value || buildEmptyTableSql(tableAdminSqlOptionsForNode(node)),
      onSuccess: async (node) => {
        const messageKey = databaseTypeForNode(node) === "clickhouse" ? "contextMenu.emptyTableSubmitted" : "contextMenu.emptyTableSuccess";
        toast(t(messageKey, { name: node.label }), 3000);
        await options.refreshMutatedTableDataTabsForNode(node);
      },
    });
  }

  function truncateTable() {
    truncateTableCascade.value = false;
    void refreshTruncateTablePreviewSql();
    showTruncateTableConfirm.value = true;
  }

  async function confirmTruncateTable() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    await runDangerOperation({
      node,
      buildSql: () => truncateTablePreviewSql.value || buildTruncateTableSql(tableAdminSqlOptionsForNode(node, { cascade: truncateTableCascade.value && supportsTruncateTableCascade(databaseTypeForNode(node)) })),
      onSuccess: async (node) => {
        toast(t("contextMenu.truncateTableSuccess", { name: node.label }), 3000);
        await options.refreshMutatedTableDataTabsForNode(node);
      },
    });
  }

  return {
    isTableNotView,
    supportsTruncate,
    supportsVacuum,
    canDropTableCascade,
    canTruncateTableCascade,
    supportsMysqlAutoIncrement,
    refreshDropTablePreviewSql,
    refreshTruncateTablePreviewSql,
    dropTable,
    refreshTableList,
    confirmDropTable,
    emptyTable,
    confirmEmptyTable,
    truncateTable,
    confirmTruncateTable,
    vacuumTable,
    refreshVacuumPreviewForOptions,
    confirmVacuumTable,
    mysqlAutoIncrement,
    refreshMysqlAutoIncrementPreviewSql,
    confirmMysqlAutoIncrement,
  };
}
