import i18n from "@/i18n";
import * as api from "@/lib/backend/api";
import type { OracleRoutineOperation, OracleRoutineSaveInput } from "@/types/schemaDiff";
import { releaseOracleRoutineOperations, retainOracleRoutineOperations } from "./oracleRoutineOperationReferences";

export type PreparedOracleRoutineSave = (() => Promise<OracleRoutineOperation>) & { dispose?: () => Promise<void> };

// A lost client wait keeps its original ID, including after closing/reopening a
// source editor. Database readback alone must not release an unresolved write.
const pendingSaves = new Map<string, { input: OracleRoutineSaveInput; operation: OracleRoutineOperation }>();

export class OracleRoutineWriteError extends Error {
  constructor(
    public readonly operationId: string,
    public readonly operation: OracleRoutineOperation | null,
    message: string,
  ) {
    super(message);
    this.name = "OracleRoutineWriteError";
  }
}

export function oracleRoutineOperationVerified(operation: OracleRoutineOperation): boolean {
  return operation.lifecycle === "terminal" && operation.dispatched && operation.acknowledged && operation.readback?.state === "verified";
}

export function requireVerifiedOracleRoutine(operation: OracleRoutineOperation): void {
  if (oracleRoutineOperationVerified(operation)) return;
  const pending = operation.lifecycle === "running" || operation.lifecycle === "unproven";
  const stateKey = operation.readback?.state === "invalid" ? "objects.routineReadbackInvalid" : operation.readback?.state === "missing" ? "objects.routineReadbackMissing" : operation.readback?.state === "definition-mismatch" ? "objects.routineReadbackMismatch" : null;
  const companion = operation.readback?.packageCompanion;
  const details = [
    operation.dispatched && operation.acknowledged ? i18n.global.t("objects.routineWriteAcknowledged") : null,
    stateKey ? i18n.global.t(stateKey) : null,
    operation.error,
    ...(operation.readback?.issues.map((issue) => issue.message) ?? []),
    ...(operation.readback?.compilerMessages.map((message) => `${message.attribute} ${message.line}:${message.position} ${message.text}`) ?? []),
    ...(companion
      ? [`${companion.identity.kind.replaceAll("_", " ")}: ${companion.version?.status ?? companion.state}`, ...companion.issues.map((issue) => issue.message), ...companion.compilerMessages.map((message) => `${message.attribute} ${message.line}:${message.position} ${message.text}`)]
      : []),
  ]
    .filter(Boolean)
    .join("\n");
  throw new OracleRoutineWriteError(operation.operationId, operation, `${i18n.global.t(pending ? "objects.routineWritePending" : "objects.routineWriteUnverified", { operationId: operation.operationId })}${details ? `\n${details}` : ""}`);
}

/** Prepare BEFORE production confirmation, execute the exact approved draft
 * afterwards. Keeping these phases separate binds confirmation to its endpoint. */
export async function prepareOracleRoutineSourceSave(input: OracleRoutineSaveInput, { retainTerminalResult = false }: { retainTerminalResult?: boolean } = {}): Promise<PreparedOracleRoutineSave> {
  input = { ...input, identity: { ...input.identity } };
  const key = JSON.stringify([input.connectionId, input.database, input.identity.owner, input.identity.name]);
  const pending = pendingSaves.get(key);
  let prepared: OracleRoutineOperation | undefined;
  if (pending) {
    let latest;
    try {
      latest = await api.observeOracleRoutineOperation(pending.operation.operationId, false);
    } catch {
      /* Retain the original ID below. */
    }
    if (latest?.operation?.lifecycle === "prepared") {
      // Core atomically supersedes Prepared, preventing its late execute from
      // racing the edited approval. Running/unproven cannot take this path.
      try {
        prepared = await api.prepareOracleRoutineSave({ ...input, supersedesOperationId: pending.operation.operationId });
        await retainOracleRoutineOperations([prepared.operationId]);
      } catch {
        if (prepared) await releaseOracleRoutineOperations([prepared.operationId]);
        throw new OracleRoutineWriteError(pending.operation.operationId, latest.operation, i18n.global.t("objects.routineWritePending", { operationId: pending.operation.operationId }));
      }
      if (pendingSaves.get(key) === pending) pendingSaves.delete(key);
      await releaseOracleRoutineOperations([pending.operation.operationId]);
    } else {
      // A new Save click is only a status check while an earlier write is pending.
      return async () => {
        let observed;
        try {
          observed = await api.observeOracleRoutineOperation(pending.operation.operationId, true);
        } catch {
          throw new OracleRoutineWriteError(pending.operation.operationId, pending.operation, i18n.global.t("objects.routineWritePending", { operationId: pending.operation.operationId }));
        }
        if (!observed.operation) throw new OracleRoutineWriteError(pending.operation.operationId, null, i18n.global.t("objects.routineWritePending", { operationId: pending.operation.operationId }));
        if (observed.operation.lifecycle === "terminal" && pendingSaves.get(key) === pending) {
          pendingSaves.delete(key);
          await releaseOracleRoutineOperations([pending.operation.operationId]);
        }
        requireVerifiedOracleRoutine(observed.operation);
        // Reconciliation of the previous SQL must never mark a newer draft clean.
        if (input.sql !== pending.input.sql || input.identity.kind !== pending.input.identity.kind) throw new OracleRoutineWriteError(pending.operation.operationId, observed.operation, i18n.global.t("objects.routineWriteDraftChanged"));
        return observed.operation;
      };
    }
  }
  const approval = prepared ?? (await api.prepareOracleRoutineSave(input));
  if (!prepared) {
    try {
      await retainOracleRoutineOperations([approval.operationId]);
    } catch (error) {
      await releaseOracleRoutineOperations([approval.operationId]);
      throw error;
    }
  }
  let transferred = false;
  let disposed = false;
  let retainedTerminal = false;
  const execute = async () => {
    // Different source editors may have prepared concurrently. The Core target
    // hold is authoritative; this map also retains the first unresolved ID.
    const active = pendingSaves.get(key);
    if (active) throw new OracleRoutineWriteError(active.operation.operationId, active.operation, i18n.global.t("objects.routineWritePending", { operationId: active.operation.operationId }));
    if (disposed || transferred) throw new OracleRoutineWriteError(approval.operationId, approval, i18n.global.t("objects.routineWritePending", { operationId: approval.operationId }));
    transferred = true;
    pendingSaves.set(key, { input, operation: approval });
    let operation: OracleRoutineOperation;
    try {
      operation = await api.executeOracleRoutineOperation(approval.operationId, input.sql);
    } catch {
      // The execute request may have arrived. Never prepare a replacement ID.
      try {
        const observed = await api.observeOracleRoutineOperation(approval.operationId, false);
        if (!observed.operation) throw new Error("unavailable");
        operation = observed.operation;
      } catch {
        throw new OracleRoutineWriteError(approval.operationId, approval, i18n.global.t("objects.routineWritePending", { operationId: approval.operationId }));
      }
    }
    if (pendingSaves.get(key)?.operation.operationId === approval.operationId) {
      if (operation.lifecycle === "terminal") {
        pendingSaves.delete(key);
        if (retainTerminalResult) retainedTerminal = true;
        else await releaseOracleRoutineOperations([approval.operationId]);
      } else pendingSaves.set(key, { input, operation });
    }
    requireVerifiedOracleRoutine(operation);
    return operation;
  };
  return Object.assign(execute, {
    dispose: async () => {
      if ((transferred && !retainedTerminal) || disposed) return;
      disposed = true;
      await releaseOracleRoutineOperations([approval.operationId]);
    },
  });
}
