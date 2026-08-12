export interface ConnectionNoteVisibilityDraft {
  value: boolean;
  dirty: boolean;
}

export function createConnectionNoteVisibilityDraft(persistedValue: boolean): ConnectionNoteVisibilityDraft {
  return { value: persistedValue, dirty: false };
}

export function setConnectionNoteVisibilityDraft(draft: ConnectionNoteVisibilityDraft, value: boolean): void {
  draft.value = value;
  draft.dirty = true;
}

export function syncConnectionNoteVisibilityDraft(draft: ConnectionNoteVisibilityDraft, persistedValue: boolean): void {
  if (draft.dirty) return;
  draft.value = persistedValue;
}

export function resetConnectionNoteVisibilityDraft(draft: ConnectionNoteVisibilityDraft, persistedValue: boolean): void {
  draft.value = persistedValue;
  draft.dirty = false;
}

export async function persistConnectionNoteVisibilityDraft(draft: ConnectionNoteVisibilityDraft, persistedValue: boolean, persist: (value: boolean) => Promise<void>): Promise<void> {
  if (!draft.dirty) return;
  if (draft.value !== persistedValue) await persist(draft.value);
  draft.dirty = false;
}
