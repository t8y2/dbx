export interface SavedSqlFolderCountNode {
  id: string;
  parentFolderId?: string;
}

export function savedSqlFolderBranchFileCount(folderId: string, folders: readonly SavedSqlFolderCountNode[], filesInFolder: (folderId: string) => readonly unknown[]): number {
  const visited = new Set<string>();

  const count = (currentFolderId: string): number => {
    if (visited.has(currentFolderId)) return 0;
    visited.add(currentFolderId);

    let total = filesInFolder(currentFolderId).length;
    for (const child of folders) {
      if ((child.parentFolderId || "") === currentFolderId) {
        total += count(child.id);
      }
    }
    return total;
  };

  return count(folderId);
}
