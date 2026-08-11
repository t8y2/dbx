export interface SavedSqlDirectoryImportEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: SavedSqlDirectoryImportEntry[];
}

export interface SavedSqlDirectoryImportFile {
  name: string;
  path: string;
  folderNames: string[];
}

export function collectSavedSqlDirectoryImportFiles(entries: SavedSqlDirectoryImportEntry[], folderNames: string[] = []): SavedSqlDirectoryImportFile[] {
  const files: SavedSqlDirectoryImportFile[] = [];
  for (const entry of entries) {
    if (entry.is_dir) {
      files.push(...collectSavedSqlDirectoryImportFiles(entry.children, [...folderNames, entry.name]));
    } else {
      files.push({ name: entry.name, path: entry.path, folderNames });
    }
  }
  return files;
}
