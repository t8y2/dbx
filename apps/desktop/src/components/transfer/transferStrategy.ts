import type { TransferContent, TransferMode, TransferOwnershipPolicy, TransferOwnershipPreview, TransferRequest } from "@/lib/backend/api";
import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";

export type TransferStrategy = TransferMode | "rebuild";

export function resolveTransferStrategy(options: { mode?: TransferMode; dropTargetBeforeCreate?: boolean }): TransferStrategy {
  return options.dropTargetBeforeCreate ? "rebuild" : (options.mode ?? "append");
}

export function transferStrategyOptions(strategy: TransferStrategy): Pick<TransferRequest, "mode" | "dropTargetBeforeCreate"> {
  return { mode: strategy === "rebuild" ? "append" : strategy, dropTargetBeforeCreate: strategy === "rebuild" };
}

const REBUILD_TARGET_TYPES = new Set<DatabaseType>(["mysql", "postgres", "sqlserver", "kingbase", "gaussdb", "opengauss", "kwdb", "goldendb", "sqlite", "duckdb", "cloudflare-d1"]);

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
