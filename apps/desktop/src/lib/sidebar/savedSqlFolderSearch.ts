import type { SavedSqlFolder } from "@/types/database";

/**
 * The nearest folder in a file's parent chain that `isFolderLocked` rejects.
 * Callers decide what "locked" means (e.g. protected and not unlocked in this
 * session). Each folder in the chain is walked at most once, so cycles cannot
 * hang the caller.
 */
export function nearestLockedFolder(folderId: string | undefined, allFolders: readonly SavedSqlFolder[], isFolderLocked: (folder: SavedSqlFolder) => boolean): SavedSqlFolder | null {
  const visited = new Set<string>();
  let currentId = folderId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const folder = allFolders.find((candidate) => candidate.id === currentId);
    if (!folder) return null;
    if (isFolderLocked(folder)) return folder;
    currentId = folder.parentFolderId;
  }
  return null;
}
