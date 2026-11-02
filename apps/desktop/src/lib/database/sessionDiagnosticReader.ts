import * as api from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import { uuid } from "@/lib/common/utils";
import { materializeLargeValueSnapshot, waitForLargeValueSnapshot } from "@/lib/dataGrid/largeValueSnapshot";
import type { QueryResult } from "@/types/database";

type DiagnosticBackend = Pick<typeof api, "executeQuery" | "cancelQuery" | "closeClientConnectionSession" | "readLargeValueChunk">;

export class DiagnosticReadStopped extends Error {
  constructor(public readonly reason: "cancelled" | "timeout") {
    super(`Diagnostic reading ${reason}`);
  }
}

export function createSessionDiagnosticReader(context: { connectionId: string; database: string }, backend: DiagnosticBackend = api) {
  const { connectionId, database } = context;
  const clientSessionId = `session-diagnostics:${uuid()}`;
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const executionIds = new Set<string>();
  let closeRequested = false;
  let closeStarted = false;
  let cleanupError: unknown;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void closed.catch(() => undefined);
  const deadline = setTimeout(() => stop("timeout"), 60_000);

  function closeWhenSettled() {
    if (!closeRequested || closeStarted || pending.size) return;
    closeStarted = true;
    void backend
      .closeClientConnectionSession(connectionId, database, clientSessionId)
      .then(resolveClosed)
      .catch((error) => {
        cleanupError = error;
        rejectClosed(error);
      });
  }

  function track<T>(transport: Promise<T>, executionId: string): Promise<T> {
    executionIds.add(executionId);
    const tracked = transport.finally(() => {
      pending.delete(tracked);
      executionIds.delete(executionId);
      closeWhenSettled();
    });
    pending.add(tracked);
    return tracked;
  }

  function stop(reason: "cancelled" | "timeout" = "cancelled") {
    closeRequested = true;
    clearTimeout(deadline);
    if (!controller.signal.aborted) {
      controller.abort(new DiagnosticReadStopped(reason));
      for (const executionId of executionIds) void backend.cancelQuery(executionId).catch(() => undefined);
    }
    closeWhenSettled();
  }

  async function query(sql: string, maxRows = 501): Promise<QueryResult> {
    controller.signal.throwIfAborted();
    const executionId = uuid();
    const timer = setTimeout(() => stop("timeout"), 10_000);
    try {
      const transport = track(backend.executeQuery(connectionId, database, sql, undefined, executionId, { clientSessionId, maxRows, timeoutSecs: 10 }), executionId);
      const result = await waitForLargeValueSnapshot(transport, controller.signal);
      controller.signal.throwIfAborted();
      if (result.execution_error) throw new Error(result.error ? formatError(result.error) : "Diagnostic query failed");
      if (result.large_value_cells?.some((cell) => cell.value_ref) && !result.large_value_context) return { ...result, large_value_context: { connectionId, database, clientSessionId } };
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async function readCell(result: QueryResult, rowIndex: number, columnIndex: number): Promise<string> {
    controller.signal.throwIfAborted();
    const cell = result.large_value_cells?.find((value) => value.row_index === rowIndex && value.column_index === columnIndex);
    if (!cell) return String(result.rows[rowIndex]?.[columnIndex] ?? "");
    if (!cell.value_ref) throw new Error("SQL preview has no complete snapshot reference");
    const original = result.large_value_context;
    if (!original || original.connectionId !== connectionId || original.database !== database || original.clientSessionId !== clientSessionId || original.txnSessionId) throw new Error("SQL snapshot context changed");
    const executionId = uuid();
    const timer = setTimeout(() => stop("timeout"), 10_000);
    try {
      return await materializeLargeValueSnapshot(
        { ...original, valueRef: cell.value_ref, executionId },
        () => !controller.signal.aborted,
        controller.signal,
        async (request) => {
          const chunk = await track(backend.readLargeValueChunk(request), executionId);
          if (chunk.status !== "ok") throw new Error(`Diagnostic SQL snapshot ${chunk.status}; refresh diagnostics`);
          return chunk;
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    query,
    readCell,
    stop,
    close: () => stop(),
    closed,
    get cleanupError() {
      return cleanupError;
    },
  };
}

export type SessionDiagnosticReader = ReturnType<typeof createSessionDiagnosticReader>;
