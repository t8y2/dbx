import { ref, type Ref } from "vue";

export type FavoriteDialogMode = "note" | "group";

export interface FavoriteDialogState {
  open: boolean;
  mode: FavoriteDialogMode;
  initialValue: string;
  title?: string;
  /** When set, "group" mode renames this group; otherwise it creates a new one. */
  groupId?: string;
  /** Connection+database scope for group mode. */
  connectionId?: string;
  database?: string;
  /** Favorite key for note mode (which favorite's note to edit). */
  favoriteKey?: string;
  /** Optional `data` payload. Used for group-mode `name` placeholder etc. */
  meta?: Record<string, unknown>;
}

const state: Ref<FavoriteDialogState | null> = ref(null);

export function useFavoriteEditDialog(): {
  state: Ref<FavoriteDialogState | null>;
  openNoteEdit: (key: string, initialNote: string) => void;
  openGroupCreate: (connectionId: string, database: string) => void;
  openGroupRename: (groupId: string, connectionId: string, database: string, currentName: string) => void;
  close: () => void;
} {
  function openNoteEdit(key: string, initialNote: string): void {
    state.value = { open: true, mode: "note", initialValue: initialNote, favoriteKey: key };
  }

  function openGroupCreate(connectionId: string, database: string): void {
    state.value = { open: true, mode: "group", initialValue: "", connectionId, database };
  }

  function openGroupRename(groupId: string, connectionId: string, database: string, currentName: string): void {
    state.value = { open: true, mode: "group", initialValue: currentName, groupId, connectionId, database };
  }

  function close(): void {
    if (state.value) state.value = { ...state.value, open: false };
  }

  return { state, openNoteEdit, openGroupCreate, openGroupRename, close };
}
