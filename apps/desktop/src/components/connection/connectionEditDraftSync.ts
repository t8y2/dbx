export type ConnectionEditDraftSyncAction = "hydrate" | "reset" | "preserve";

export interface ConnectionTestPersistenceState {
  testConfigId: string;
  activeDraftId: string | null;
  testRunId: number;
  activeTestRunId: number;
  submittedFingerprint: string;
  savedFingerprint: string;
  currentDraftFingerprint: string;
}

export function connectionEditDraftSyncAction(configId: string | null, isOpen: boolean, activeDraftId: string | null): ConnectionEditDraftSyncAction {
  if (!isOpen) return "preserve";
  // Saved snapshots for the active connection must not overwrite its draft,
  // while a different id is an explicit request to switch editing targets.
  if (configId && configId === activeDraftId) return "preserve";
  return configId ? "hydrate" : "reset";
}

export function canPersistConnectionTestResult(state: ConnectionTestPersistenceState): boolean {
  return state.testConfigId === state.activeDraftId && state.testRunId === state.activeTestRunId && state.submittedFingerprint === state.savedFingerprint && state.currentDraftFingerprint === state.submittedFingerprint;
}
