export type ConnectionEditDraftSyncAction = "hydrate" | "reset" | "preserve";

export function connectionEditDraftSyncAction(configId: string | null, isOpen: boolean, activeDraftId: string | null): ConnectionEditDraftSyncAction {
  if (!isOpen) return "preserve";
  // Saved snapshots for the active connection must not overwrite its draft,
  // while a different id is an explicit request to switch editing targets.
  if (configId && configId === activeDraftId) return "preserve";
  return configId ? "hydrate" : "reset";
}
