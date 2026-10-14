import type { SavedSqlFile, SavedSqlFolder } from "@/types/database";

/**
 * Whether a folder — or any folder above it in the parent chain — carries a
 * protection password. Purely a property of the stored data: a folder that
 * was unlocked in the current session still counts as protected here, so the
 * search results never leak locked branches (folder names, SQL snippets)
 * through a temporary unlock.
 */
export function folderOrAncestorHasPassword(folder: SavedSqlFolder, allFolders: readonly SavedSqlFolder[]): boolean {
  const visited = new Set<string>();
  let current: SavedSqlFolder | undefined = folder;
  while (current) {
    if (current.passwordHash) return true;
    if (!current.parentFolderId || visited.has(current.id)) return false;
    visited.add(current.id);
    const parentFolderId: string | undefined = current.parentFolderId;
    current = allFolders.find((candidate) => candidate.id === parentFolderId);
  }
  return false;
}

/**
 * Whether a file lives in a protected branch — its folder or any folder above
 * it carries a protection password. Used by search, so this is a pure property
 * of the stored data and deliberately ignores session unlocks.
 */
export function fileOrAncestorHasPassword(file: Pick<SavedSqlFile, "folderId">, allFolders: readonly SavedSqlFolder[]): boolean {
  if (!file.folderId) return false;
  const folder = allFolders.find((candidate) => candidate.id === file.folderId);
  return !!folder && folderOrAncestorHasPassword(folder, allFolders);
}

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
