import type { SavedSqlFolder } from "@/types/database";

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
