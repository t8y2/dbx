import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

function functionBody(source: string, name: string): string {
  const signature = `function ${name}(`;
  const asyncSignature = `async ${signature}`;
  const signatureIndex = source.indexOf(asyncSignature) >= 0 ? source.indexOf(asyncSignature) : source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `Could not find function ${name}`);
  const bodyStart = source.indexOf("{", signatureIndex);
  assert.notEqual(bodyStart, -1, `Could not find body for ${name}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  throw new Error(`Could not parse body for ${name}`);
}

/**
 * Region of one top-level function in a store/component module. Unlike
 * `functionBody`, this survives inline object type literals in the parameter
 * list (the first `{` there is not the body).
 */
function functionRegion(source: string, name: string): string {
  const candidates = [`  async function ${name}(`, `  function ${name}(`].map((marker) => source.indexOf(marker)).filter((index) => index >= 0);
  assert.notEqual(candidates.length, 0, `Could not find function ${name}`);
  const start = Math.min(...candidates);
  const rest = source.slice(start + 1);
  const next = /\n  (?:async )?function /.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

test("object source identity and editability are enforced in queryStore", () => {
  const queryStore = readFileSync("apps/desktop/src/stores/queryStore.ts", "utf8");
  const findBody = functionRegion(queryStore, "findMatchingObjectSourceTab");
  const pendingBody = functionRegion(queryStore, "openObjectSourceTabPending");
  const applyBody = functionRegion(queryStore, "applyLoadedObjectSource");

  // canonical identity：连接 + 库 + schema + catalog + 解析后的对象身份共同决定复用哪个 tab
  assert.match(findBody, /tab\.objectSource\?\.name === options\.objectSource\.name/);
  assert.match(findBody, /tab\.objectSource\.objectType === options\.objectSource\.objectType/);
  assert.match(findBody, /\(tab\.objectSource\.schema \|\| ""\) === \(options\.objectSource\.schema \|\| ""\)/);
  assert.match(findBody, /\(tab\.objectSource\.signature \|\| ""\) === \(options\.objectSource\.signature \|\| ""\)/);

  // honor backend editability：只读源码不挂 objectSource，但仍是一个 sourceView tab
  assert.match(applyBody, /raw\.editable !== false/);
  assert.match(applyBody, /OBJECT_SOURCE_READ_ONLY_TYPES\.includes\(loaded\.resolvedType\)/);
  assert.match(applyBody, /tab\.sourceView = true/);
  assert.match(queryStore, /const OBJECT_SOURCE_READ_ONLY_TYPES: readonly ObjectSourceKind\[\] = \["SEQUENCE", "TRIGGER", "TYPE", "TYPE_BODY", "JOB"\]/);

  // pending 占位：同步返回（不 await），tab 已可见并带着可重试的请求身份
  assert.doesNotMatch(pendingBody, /await /);
  assert.match(pendingBody, /tab\.sourceLoad = \{ startedAt: Date\.now\(\), initialEditing: options\.initialEditing, request: \{ \.\.\.options\.request \} \}/);
  assert.match(pendingBody, /void loadObjectSourceIntoTab\(id\)/);
  // 落地时清掉加载态，否则 tab 会永远停在转圈
  assert.match(applyBody, /clearObjectSourceLoad\(tab\)/);
});

test("successful tree table paste consumes only the clipboard used to start it", () => {
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const confirmPasteTableBody = functionBody(runtimeHost, "confirmPasteTable");

  assert.match(confirmPasteTableBody, /const clipboardAtPasteStart = connectionStore\.treeClipboard/);
  assert.match(confirmPasteTableBody, /if \(pasteFailCount === 0\)/);
  assert.match(confirmPasteTableBody, /connectionStore\.treeClipboard === clipboardAtPasteStart/);
  assert.match(confirmPasteTableBody, /connectionStore\.treeClipboard = null/);
});

test("tree table paste keeps the clipboard when production confirmation is cancelled", () => {
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const confirmPasteTableBody = functionBody(runtimeHost, "confirmPasteTable");

  assert.match(confirmPasteTableBody, /const structureExecuted = await executeTreeNodeSqlWithProductionGuard[\s\S]*?if \(!structureExecuted\) \{[\s\S]*?pasteCancelled = true;[\s\S]*?break;/);
  assert.match(confirmPasteTableBody, /const dataExecuted = await executeTreeNodeSqlWithProductionGuard[\s\S]*?if \(!dataExecuted\) \{[\s\S]*?pasteCancelled = true;[\s\S]*?break;/);
  assert.match(confirmPasteTableBody, /queueRefreshTarget\(entry\)/);
  assert.match(confirmPasteTableBody, /if \(pasteCancelled\) \{[\s\S]*?if \(hasMutatedTable && refreshFailCount === 0\)[\s\S]*?pasteTableCancelledAfterPartial[\s\S]*?return;/);
});

test("tree table paste consumes the clipboard even if only the object-list refresh fails", () => {
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const confirmPasteTableBody = functionBody(runtimeHost, "confirmPasteTable");

  assert.match(confirmPasteTableBody, /let pasteFailCount = 0/);
  assert.match(confirmPasteTableBody, /let refreshFailCount = 0/);
  assert.match(confirmPasteTableBody, /pasteFailCount\+\+/);
  assert.match(confirmPasteTableBody, /refreshFailCount\+\+/);
  assert.match(confirmPasteTableBody, /if \(pasteFailCount === 0\)[\s\S]*?connectionStore\.treeClipboard = null/);
  assert.match(confirmPasteTableBody, /if \(refreshFailCount > 0\)[\s\S]*?pasteTableRefreshFailed/);
});

test("saved SQL tree rows expose copy, paste, export, rename, and confirmed deletion through the shared runtime host", () => {
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const connectionTree = readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8");
  const treeItem = readFileSync("apps/desktop/src/components/sidebar/TreeItem.vue", "utf8");
  const specialMenuBody = functionBody(runtimeHost, "buildSpecialSidebarMenu");
  const pasteBody = functionBody(runtimeHost, "requestPasteTreeClipboard");
  const savedSqlMenuStart = specialMenuBody.indexOf('if (node.type === "saved-sql-file")');
  const savedSqlMenuEnd = specialMenuBody.indexOf("// 5. Redis DB / Mongo DB", savedSqlMenuStart);
  const savedSqlMenuBody = specialMenuBody.slice(savedSqlMenuStart, savedSqlMenuEnd);

  assert.match(specialMenuBody, /node\.type === "saved-sql-root"[\s\S]*?savedSql\.pasteFile/);
  assert.match(savedSqlMenuBody, /savedSql\.copyFile[\s\S]*?savedSql\.pasteFile[\s\S]*?sqlLibrary\.exportFile[\s\S]*?savedSql\.renameFile[\s\S]*?savedSql\.deleteFile/);
  assert.match(savedSqlMenuBody, /action: deleteSavedSqlFile[\s\S]*?variant: "destructive"/);
  assert.doesNotMatch(savedSqlMenuBody, /contextMenu\.copyName/);
  assert.match(pasteBody, /clipboard\?\.kind === "saved-sql-copy"[\s\S]*?copyFilesToDatabase/);
  assert.match(runtimeHost, /activeNode\.value\.type === "saved-sql-file"[\s\S]*?request-saved-sql-rename/);
  assert.match(connectionTree, /@request-saved-sql-rename="startRenamingSavedSqlNode"/);
  assert.match(treeItem, /async function finishRenameSavedSql\(\)[\s\S]*?savedSqlStore\.renameFile/);
  assert.match(runtimeHost, /routeDangerDialog\(showDeleteSavedSqlConfirm[\s\S]*?savedSql\.deleteFileConfirm[\s\S]*?confirmDeleteSavedSqlFile/);
  assert.match(runtimeHost, /async function confirmDeleteSavedSqlFile\(\)[\s\S]*?savedSqlStore\.deleteFile[\s\S]*?connectionStore\.removeTreeNode/);
  assert.match(functionBody(runtimeHost, "requestDeleteSelectedNode"), /saved-sql-file[\s\S]*?showDeleteSavedSqlConfirm\.value = true/);
});
