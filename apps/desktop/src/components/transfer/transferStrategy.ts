import type { TransferContent, TransferMode, TransferOwnershipPolicy, TransferOwnershipPreview, TransferRequest } from "@/lib/backend/api";
import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";

export type TransferStrategy = TransferMode | "rebuild";

/** Fail-closed discriminator: a structure-only transfer may not run without its SQL preview. */
export const TRANSFER_STRUCTURE_PREVIEW_UNAVAILABLE = "TRANSFER_STRUCTURE_PREVIEW_UNAVAILABLE";

export function resolveTransferStrategy(options: { mode?: TransferMode; dropTargetBeforeCreate?: boolean }): TransferStrategy {
  return options.dropTargetBeforeCreate ? "rebuild" : (options.mode ?? "append");
}

export function transferStrategyOptions(strategy: TransferStrategy): Pick<TransferRequest, "mode" | "dropTargetBeforeCreate"> {
  return { mode: strategy === "rebuild" ? "append" : strategy, dropTargetBeforeCreate: strategy === "rebuild" };
}

const REBUILD_TARGET_TYPES = new Set<DatabaseType>(["mysql", "postgres", "sqlserver", "kingbase", "gaussdb", "opengauss", "kwdb", "goldendb", "sqlite", "duckdb", "cloudflare-d1"]);

export function supportsTransferUpsert(targetType: DatabaseType | undefined): boolean {
  return targetType !== "db2" && targetType !== "iris";
}

export function rebuildUnavailableReason(content: TransferContent, targetType: DatabaseType | undefined): "dataOnly" | "unsupported" | undefined {
  if (content === "dataOnly") return "dataOnly";
  return targetType && REBUILD_TARGET_TYPES.has(targetType) ? undefined : "unsupported";
}

/** Snapshot the complete selection before any asynchronous preview or confirmation. */
function freezeTransferRequest(request: TransferRequest): TransferRequest {
  const snapshot = {
    ...request,
    ...transferStrategyOptions(resolveTransferStrategy(request)),
    tables: [...request.tables],
    objects: request.objects.map((selection) => ({ ...selection, names: [...selection.names] })),
    dropTargetConfirmed: false,
  };
  Object.freeze(snapshot.tables);
  for (const selection of snapshot.objects) {
    Object.freeze(selection.names);
    Object.freeze(selection);
  }
  Object.freeze(snapshot.objects);
  return Object.freeze(snapshot);
}

/**
 * The SQL document a SQL-preview confirmation shows and reviews.
 *
 * A rebuild is composed around the structure plan so each operation appears exactly once and
 * in execution order — rename the old target aside, create the new structure, drop the
 * backups after success. Without a rebuild (or without a structure plan) it is just the
 * structure SQL, and a backend that only reports the combined rebuild plan keeps its
 * existing `rebuild.sql`.
 */
export function transferPreviewSql(preview: TransferOwnershipPreview): string {
  const sections = [preview.rebuild?.backupSql, preview.structure?.sql, preview.rebuild?.cleanupSql].filter((section): section is string => Boolean(section));
  if (sections.length > 0) return sections.join("\n\n");
  return preview.rebuild?.sql ?? "";
}

/** Production review keeps the human-readable plan ahead of the exact SQL preview. */
export function transferPlanReviewText(strategy: string, summary: string, preview: TransferOwnershipPreview): string {
  return [strategy, summary, transferPreviewSql(preview)].filter(Boolean).join("\n\n");
}

/** Whether this preview has SQL the user must review in a read-only confirmation. */
export function hasTransferSqlPreview(preview: TransferOwnershipPreview): boolean {
  return Boolean(preview.rebuild || preview.structure);
}

interface TransferSubmissionOptions {
  ensureWritable?: (request: TransferRequest) => Promise<boolean>;
  preview: (request: TransferRequest) => Promise<TransferOwnershipPreview>;
  confirmOwnership: (preview: TransferOwnershipPreview) => Promise<TransferOwnershipPolicy | null>;
  confirm: (request: TransferRequest, preview: TransferOwnershipPreview) => Promise<boolean>;
  execute: (request: TransferRequest) => void;
}

/** Invalidating a submission prevents every later await from reopening prompts or starting it. */
export function createTransferSubmission(options: TransferSubmissionOptions) {
  let generation = 0;
  return {
    cancel() {
      generation += 1;
    },
    async start(input: TransferRequest): Promise<boolean> {
      const token = ++generation;
      const isCurrent = () => token === generation;
      let request = freezeTransferRequest(input);
      try {
        if (options.ensureWritable && (!(await options.ensureWritable(request)) || !isCurrent())) return false;
        let preview: TransferOwnershipPreview = request.content === "dataOnly" ? { missingOwners: [], targetOwner: "" } : await options.preview(request);
        if (!isCurrent()) return false;
        if (preview.missingOwners.length > 0) {
          const policy = await options.confirmOwnership(preview);
          if (!policy || !isCurrent()) return false;
          if (policy !== request.ownershipPolicy) {
            request = freezeTransferRequest({ ...request, ownershipPolicy: policy });
            preview = await options.preview(request);
            if (!isCurrent()) return false;
          }
        }
        if (request.dropTargetBeforeCreate && !preview.rebuild) throw new Error("TRANSFER_REBUILD_PREVIEW_UNAVAILABLE");
        // A structure-only transfer changes the target schema; never fall back to the plain
        // start confirmation when the backend did not say what it is going to run.
        if (request.content === "structureOnly" && !preview.structure) throw new Error(TRANSFER_STRUCTURE_PREVIEW_UNAVAILABLE);
        if (!(await options.confirm(request, preview)) || !isCurrent()) return false;
        options.execute(Object.freeze({ ...request, dropTargetConfirmed: request.dropTargetBeforeCreate }));
        return true;
      } catch (error) {
        if (!isCurrent()) return false;
        throw error;
      }
    },
  };
}

/** The shared production prompt also serves as the destructive rebuild confirmation. */
export function confirmTransferWithProductionSafety(options: { request: TransferRequest; connection?: ConnectionConfig; reviewText: string; source?: string; confirm: () => Promise<boolean> }): Promise<boolean> {
  const context = productionContextForDatabase(options.connection, options.request.targetDatabase);
  if (!context.active) return options.confirm();
  return useProductionSafetyStore().requestConfirmation({
    sql: options.reviewText,
    connectionName: options.connection?.name,
    database: options.request.targetDatabase,
    productionDatabases: context.databases,
    source: options.source,
    scopeId: options.request.transferId,
  });
}
