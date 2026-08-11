import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const source = readFileSync("apps/desktop/src/components/layout/SqlLibraryPanel.vue", "utf8");

test("SQL library imports use the charset-aware external SQL reader", () => {
  const start = source.indexOf("async function importDirectoryIntoLibrary");
  const end = source.indexOf("async function chooseSyncDirectory", start);
  const handler = start >= 0 && end > start ? source.slice(start, end) : "";

  assert.match(handler, /await api\.readExternalSqlFile\(path\)/);
  assert.doesNotMatch(handler, /readTextFile/);
});

test("SQL library directory imports use the native pruned folder scanner", () => {
  const start = source.indexOf("async function collectSqlFilesRecursively");
  const end = source.indexOf("async function importDirectoryIntoLibrary", start);
  const scanner = start >= 0 && end > start ? source.slice(start, end) : "";

  assert.match(scanner, /await api\.listSqlFilesInFolder\(dir\)/);
  assert.doesNotMatch(scanner, /@tauri-apps\/plugin-fs|readDir/);
});

test("SQL library directory imports preserve nested folder paths", () => {
  const start = source.indexOf("async function importDirectoryIntoLibrary");
  const end = source.indexOf("async function chooseSyncDirectory", start);
  const handler = start >= 0 && end > start ? source.slice(start, end) : "";

  assert.match(handler, /resolveImportedFolder\(connectionId, targetFolder\?\.id, file\.folderNames, folderCache\)/);
  assert.match(handler, /uniqueImportedName\(file\.name, takenNames\)/);
  assert.doesNotMatch(handler, /relativeImportName/);
});

test("SQL library file menu can open a file with the current tab target", () => {
  assert.match(source, /label: t\("sqlLibrary\.openInCurrentDatabase"\)/);
  assert.match(source, /action: \(\) => openFile\(target, "current"\)/);
  assert.match(source, /disabled: !hasCurrentSavedSqlExecutionTarget\.value/);
});
