import type { SavedSqlFile, SavedSqlFolder } from "@/types/database";

export type SavedSqlTreeSortMode = "folder" | "date";

export type SavedSqlTreeFolderRow = {
  type: "folder";
  folder: SavedSqlFolder;
  depth: number;
};

export type SavedSqlTreeFileRow = {
  type: "file";
  file: SavedSqlFile;
  depth: number;
};

export type SavedSqlTreeRow = SavedSqlTreeFolderRow | SavedSqlTreeFileRow;

export interface SavedSqlTreeRowsOptions {
  mode: SavedSqlTreeSortMode;
  isFolderExpanded?: (folder: SavedSqlFolder) => boolean;
  folderMatches?: (folder: SavedSqlFolder) => boolean;
  fileMatches?: (file: SavedSqlFile) => boolean;
}

type SavedSqlTreeItem = { type: "folder"; folder: SavedSqlFolder } | { type: "file"; file: SavedSqlFile };

function compareNames(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function compareSiblingItems(a: SavedSqlTreeItem, b: SavedSqlTreeItem, mode: SavedSqlTreeSortMode) {
  if (mode === "date") {
    const aUpdatedAt = a.type === "folder" ? a.folder.updatedAt : a.file.updatedAt;
    const bUpdatedAt = b.type === "folder" ? b.folder.updatedAt : b.file.updatedAt;
    const dateComparison = bUpdatedAt.localeCompare(aUpdatedAt);
    if (dateComparison !== 0) return dateComparison;
  } else if (a.type !== b.type) {
    return a.type === "folder" ? -1 : 1;
  }

  const aOrderIndex = a.type === "folder" ? (a.folder.orderIndex ?? 0) : (a.file.orderIndex ?? 0);
  const bOrderIndex = b.type === "folder" ? (b.folder.orderIndex ?? 0) : (b.file.orderIndex ?? 0);
  const orderComparison = mode === "date" ? 0 : aOrderIndex - bOrderIndex;
  if (orderComparison !== 0) return orderComparison;

  const aName = a.type === "folder" ? a.folder.name : a.file.name;
  const bName = b.type === "folder" ? b.folder.name : b.file.name;
  const nameComparison = compareNames(aName, bName);
  if (nameComparison !== 0) return nameComparison;

  const typeComparison = a.type.localeCompare(b.type);
  if (typeComparison !== 0) return typeComparison;

  const aId = a.type === "folder" ? a.folder.id : a.file.id;
  const bId = b.type === "folder" ? b.folder.id : b.file.id;
  return aId.localeCompare(bId);
}

export function savedSqlFolderBranchMatches(folder: SavedSqlFolder, folders: readonly SavedSqlFolder[], files: readonly SavedSqlFile[], folderMatches: (candidate: SavedSqlFolder) => boolean, fileMatches: (candidate: SavedSqlFile) => boolean): boolean {
  const childrenByParent = new Map<string, SavedSqlFolder[]>();
  for (const candidate of folders) {
    const parentFolderId = candidate.parentFolderId || "";
    const siblings = childrenByParent.get(parentFolderId) ?? [];
    siblings.push(candidate);
    childrenByParent.set(parentFolderId, siblings);
  }

  const filesByFolder = new Map<string, SavedSqlFile[]>();
  for (const candidate of files) {
    const folderId = candidate.folderId || "";
    const siblings = filesByFolder.get(folderId) ?? [];
    siblings.push(candidate);
    filesByFolder.set(folderId, siblings);
  }

  const visited = new Set<string>();
  const matchesBranch = (candidate: SavedSqlFolder): boolean => {
    if (visited.has(candidate.id)) return false;
    visited.add(candidate.id);

    if (folderMatches(candidate)) return true;
    if ((filesByFolder.get(candidate.id) ?? []).some(fileMatches)) return true;
    return (childrenByParent.get(candidate.id) ?? []).some(matchesBranch);
  };

  return matchesBranch(folder);
}

export function buildSavedSqlTreeRows(folders: readonly SavedSqlFolder[], files: readonly SavedSqlFile[], options: SavedSqlTreeRowsOptions): SavedSqlTreeRow[] {
  const folderMatches = options.folderMatches ?? (() => true);
  const fileMatches = options.fileMatches ?? (() => true);
  const isFolderExpanded = options.isFolderExpanded ?? (() => true);

  const childrenByParent = new Map<string, SavedSqlFolder[]>();
  for (const folder of folders) {
    const parentFolderId = folder.parentFolderId || "";
    const siblings = childrenByParent.get(parentFolderId) ?? [];
    siblings.push(folder);
    childrenByParent.set(parentFolderId, siblings);
  }

  const filesByFolder = new Map<string, SavedSqlFile[]>();
  for (const file of files) {
    const folderId = file.folderId || "";
    const siblings = filesByFolder.get(folderId) ?? [];
    siblings.push(file);
    filesByFolder.set(folderId, siblings);
  }

  const matchedFolderIds = new Set(folders.filter(folderMatches).map((folder) => folder.id));

  const branchMatchCache = new Map<string, boolean>();
  const folderBranchMatches = (folder: SavedSqlFolder): boolean => {
    const cached = branchMatchCache.get(folder.id);
    if (cached !== undefined) return cached;

    const matches = folderMatches(folder) || (filesByFolder.get(folder.id) ?? []).some(fileMatches) || (childrenByParent.get(folder.id) ?? []).some(folderBranchMatches);
    branchMatchCache.set(folder.id, matches);
    return matches;
  };

  const rows: SavedSqlTreeRow[] = [];
  const appendItems = (parentFolderId: string, depth: number) => {
    const items: SavedSqlTreeItem[] = [
      ...(childrenByParent.get(parentFolderId) ?? []).filter(folderBranchMatches).map((folder) => ({ type: "folder" as const, folder })),
      ...(filesByFolder.get(parentFolderId) ?? []).filter((file) => matchedFolderIds.has(parentFolderId) || fileMatches(file)).map((file) => ({ type: "file" as const, file })),
    ];

    items.sort((a, b) => compareSiblingItems(a, b, options.mode));
    for (const item of items) {
      if (item.type === "folder") {
        rows.push({ type: "folder", folder: item.folder, depth });
        if (isFolderExpanded(item.folder)) {
          appendItems(item.folder.id, depth + 1);
        }
      } else {
        rows.push({ type: "file", file: item.file, depth });
      }
    }
  };

  appendItems("", 0);
  return rows;
}
