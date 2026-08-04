import type { TransferObjectKind } from "@/lib/backend/api";

export interface TransferObjectSelectionPayload {
  objectType: TransferObjectKind;
  names: string[];
}

/**
 * Builds the `objects` payload of a transfer request from the tree
 * selection state. TABLE is handled by `tables`, and object types that
 * are currently disabled for this transfer (data-only mode, or kinds the
 * cross-family matrix does not allow) are dropped at the request boundary
 * even if stale selections are still present in the tree.
 */
export function buildTransferObjectSelections(selectedObjects: Partial<Record<TransferObjectKind, Set<string>>>, disabledGroups: TransferObjectKind[]): TransferObjectSelectionPayload[] {
  return (Object.keys(selectedObjects) as TransferObjectKind[])
    .filter((kind) => kind !== "TABLE" && !disabledGroups.includes(kind))
    .map((kind) => ({
      objectType: kind,
      names: [...(selectedObjects[kind] ?? [])],
    }));
}
