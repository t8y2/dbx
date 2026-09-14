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

test("tree-level context menu opens with the current row items atomically", () => {
  const connectionTree = readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8");
  const contextMenu = readFileSync("apps/desktop/src/components/ui/CustomContextMenu.vue", "utf8");

  assert.match(connectionTree, /openContextMenu\(event, items\)/);
  assert.match(connectionTree, /sidebarContextMenuRef\.value\?\.close\(\)/);
  assert.match(connectionTree, /sidebarContextMenuTarget\.value = createSidebarActionTarget\(node\)/);
  assert.match(connectionTree, /sidebarContextMenuTarget\.value = null/);
  assert.match(connectionTree, /<CustomContextMenu ref="sidebarContextMenuRef"/);
  assert.match(contextMenu, /function onContextMenu\(event: MouseEvent, itemsOverride\?: ContextMenuItem\[\]\)/);
  assert.match(contextMenu, /const items = itemsOverride \?\?/);
  assert.match(contextMenu, /defineExpose\(\{ close, menuRef, subRef \}\)/);
});

test("rare sidebar dialogs share module-level async wrappers with fallbacks", () => {
  const treeItem = readFileSync("apps/desktop/src/components/sidebar/TreeItem.vue", "utf8");
  const asyncDialogs = readFileSync("apps/desktop/src/components/sidebar/sidebarAsyncDialogs.ts", "utf8");

  assert.doesNotMatch(treeItem, /defineAsyncComponent/);
  assert.match(asyncDialogs, /loadingComponent: SidebarAsyncDialogLoading/);
  assert.match(asyncDialogs, /errorComponent: SidebarAsyncDialogError/);
  assert.match(asyncDialogs, /timeout: 15_000/);
});

test("tree host owns sidebar data-open generations", () => {
  const treeItem = readFileSync("apps/desktop/src/components/sidebar/TreeItem.vue", "utf8");
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const connectionTree = readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8");

  assert.doesNotMatch(treeItem, /runSidebarDataOpenImmediately/);
  assert.doesNotMatch(treeItem, /emit\("open-data"/);
  assert.match(runtimeHost, /emit\("open-data", node, true, "default", openData\)/);
  assert.match(connectionTree, /<SidebarTreeRuntimeHost/);
  assert.match(connectionTree, /function openSidebarData/);
  assert.match(connectionTree, /runSidebarDataOpenImmediately/);
  assert.match(connectionTree, /createSidebarActionTarget\(node\)/);
});

test("query-tab object source opens the tab before connecting or loading", () => {
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const openObjectSourceBody = functionBody(runtimeHost, "openObjectSourceDialog");

  // #9035：点击后立刻建出带加载态的 tab/弹窗，ensureConnected 与 getObjectSource
  // 都必须发生在已挂载的 UI 之内，而不是先 await 完再挂载（那样界面没有任何反馈）。
  assert.match(openObjectSourceBody, /queryStore\.openObjectSourceTabPending\(\{/);
  assert.match(openObjectSourceBody, /objectType: sourceTarget\.objectType/);
  assert.match(openObjectSourceBody, /signature: sourceNode\.signature/);
  assert.match(openObjectSourceBody, /emit\("open-object-source", sourceNode, initialEditing\)/);
  // 断言「调用形态」而不是词本身：这段代码里注释会提到这两个名字
  assert.doesNotMatch(openObjectSourceBody, /ensureConnected\(/);
  assert.doesNotMatch(openObjectSourceBody, /api\.getObjectSource\(/);
  assert.doesNotMatch(openObjectSourceBody, /toast\(/);
});

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
  assert.match(pendingBody, /tab\.sourceLoad = \{ startedAt: Date\.now\(\), request: \{ \.\.\.options\.request \} \}/);
  assert.match(pendingBody, /void loadObjectSourceIntoTab\(id\)/);
  // 落地时清掉加载态，否则 tab 会永远停在转圈
  assert.match(applyBody, /clearObjectSourceLoad\(tab\)/);
});

test("table copy menu uses the shared single and multi-selection clipboard path", () => {
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const copyNameBody = functionBody(runtimeHost, "copyName");
  const copySelectedNamesBody = functionBody(runtimeHost, "copySelectedNames");
  const clipboardMenuBody = functionBody(runtimeHost, "treeTableClipboardMenuItems");

  assert.match(clipboardMenuBody, /tableClipboardMenuState\(\s*normalizedTreeClipboardTableEntries\(\)/);
  assert.match(clipboardMenuBody, /state === "paste" \? \[pasteItem\] : \[copyItem, pasteItem\]/);
  assert.match(runtimeHost, /items\.push\(\.\.\.treeTableClipboardMenuItems\(node\)\)/);
  assert.doesNotMatch(runtimeHost, /function copyTableToClipboard\(/);
  assert.doesNotMatch(copyNameBody, /updateTreeClipboardForNodes/);
  assert.match(copySelectedNamesBody, /const selectedNodes = selectedTreeNodesInVisibleOrder\(\)/);
  assert.match(copySelectedNamesBody, /selectedNodes\.length > 1 && selectedNodes\.some\(\(node\) => node\.id === activeNode\.value\.id\) \? selectedNodes : \[activeNode\.value\]/);
  assert.match(copySelectedNamesBody, /updateTreeClipboardForNodes\(nodes\)/);
  assert.match(copySelectedNamesBody, /formatSelectedTableNamesForClipboard/);
});

test("MySQL object name menus expose leaf and display-path copy choices", () => {
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const copyNameBody = functionBody(runtimeHost, "copyName");
  const copyDisplayPathBody = functionBody(runtimeHost, "copyDisplayPath");
  const copyNameMenuItemBody = functionBody(runtimeHost, "copyNameMenuItem");
  const connectionMenuBody = functionBody(runtimeHost, "buildConnectionSidebarMenu");
  const databaseMenuBody = functionBody(runtimeHost, "buildDatabaseSidebarMenu");
  const objectMenuBody = functionBody(runtimeHost, "buildObjectSidebarMenu");

  assert.match(copyNameBody, /formatSelectedTableNamesForClipboard/);
  assert.match(copyDisplayPathBody, /copyDisplayPathForTreeNode\(node, connectionName\)/);
  assert.match(copyNameMenuItemBody, /currentDatabaseType\(\) === "mysql"/);
  assert.match(copyNameMenuItemBody, /children: \[/);
  assert.match(copyNameMenuItemBody, /t\("contextMenu\.name"\)/);
  assert.match(copyNameMenuItemBody, /t\("contextMenu\.fullPath"\)/);
  assert.match(copyNameMenuItemBody, /return \{ label: t\("contextMenu\.copyName"\), action: copyName, icon: Copy, shortcut: shortcutCopyName\.value \}/);
  assert.doesNotMatch(connectionMenuBody, /copyNameMenuItem\(\)/);
  assert.match(databaseMenuBody, /items\.push\(copyNameMenuItem\(\)\)/);
  assert.match(objectMenuBody, /items\.push\(copyNameMenuItem\(\)\)/);
  assert.match(objectMenuBody, /node\.type === "trigger" \? copyNameMenuItem\(\)/);
  assert.match(objectMenuBody, /node\.type === "sequence"[\s\S]*action: copyName/);
});

test("multi-select view ddl opens a combined ddl tab instead of export structure", () => {
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const openDdlBody = functionBody(runtimeHost, "openDdl");

  assert.doesNotMatch(openDdlBody, /exportStructure\(\)/);
  assert.match(openDdlBody, /openSidebarMultiTableDdlTab\(targets\)/);
  assert.match(runtimeHost, /openDdlForSelection/);
});

test("multi-select add-to-ai only mentions tables in the active execution context", () => {
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  // The function's return type annotation contains braces, so extract the body
  // from the signature line to the next column-0 closing brace.
  const selectedAiTableTargetsBody = /function selectedAiTableTargets\([^)]*\)[^\n]*\{[\s\S]*?\n\}/.exec(runtimeHost)?.[0] ?? "";

  assert.notEqual(selectedAiTableTargetsBody, "");
  assert.match(selectedAiTableTargetsBody, /resolveSidebarDdlTargets\(/);
  assert.match(selectedAiTableTargetsBody, /target\.type === "table"/);
  assert.doesNotMatch(selectedAiTableTargetsBody, /sidebarStructureExportTargets\(/);
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

test("sidebar keyboard table copy uses the same normalized schema as the context menu", () => {
  const connectionTree = readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8");
  const copySelectedSidebarNamesBody = functionBody(connectionTree, "copySelectedSidebarNames");

  assert.match(copySelectedSidebarNamesBody, /schema: connectionObjectTreeNodeSchema\(store\.getConfig\(node\.connectionId!\), node\.database!, node\.schema\)/);
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

test("explicit locate prioritizes the saved SQL row over SQL cursor table navigation", () => {
  const connectionTree = readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8");
  const locateBody = functionBody(connectionTree, "locateTabInSidebar");

  assert.match(locateBody, /const locatesSavedSql = tabTarget\?\.type === "saved-sql-file"/);
  assert.match(locateBody, /const cursorCandidate = locatesSavedSql \? null : queryCursorTableCandidate/);
  assert.match(locateBody, /locatesSavedSql && savedSqlFile\?\.connectionId && savedSqlFile\.database[\s\S]*?type: "query-context"/);
  assert.match(locateBody, /findNodePathForTarget\(target, store\.treeNodes\)/);
});

test("tab context menu forwards the exact tab to centered sidebar locate without activating it", () => {
  const app = readFileSync("apps/desktop/src/App.vue", "utf8");
  const appSidebar = readFileSync("apps/desktop/src/components/layout/AppSidebar.vue", "utf8");
  const connectionTree = readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8");
  const appLocateBody = functionBody(app, "locateTabInSidebar");
  const sidebarLocateBody = functionBody(appSidebar, "locateTabInSidebar");
  const activeLocateBody = functionBody(connectionTree, "locateActiveTabInSidebar");
  const locateBody = functionBody(connectionTree, "locateTabInSidebar");

  assert.match(app, /@locate-tab="locateTabInSidebar"/);
  assert.match(appLocateBody, /setSidebarOpen\(true\)/);
  assert.match(appLocateBody, /await nextTick\(\)/);
  assert.match(appLocateBody, /await appSidebarRef\.value\?\.locateTabInSidebar\(tab\)/);
  assert.doesNotMatch(appLocateBody, /activateQueryTab|activeTabId/);
  assert.match(sidebarLocateBody, /return connectionTreeRef\.value\?\.locateTabInSidebar\(tab\)/);
  assert.match(appSidebar, /defineExpose\(\{ focusSearch, locateTabInSidebar \}\)/);
  assert.match(activeLocateBody, /await locateTabInSidebar\(activeTab\.value, "smart"\)/);
  assert.match(locateBody, /await scrollToSidebarNode\(match\.id, \{ align \}\)/);
  assert.match(connectionTree, /defineExpose\(\{ focusSearch, createNewGroup, collapseAllTreeNodes, locateTabInSidebar \}\)/);
  assert.match(connectionTree, /@request-connection-rename="startRenamingConnectionNode"/);
});

test("batch table paste refreshes each object list after all tables are processed", () => {
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const confirmPasteTableBody = functionBody(runtimeHost, "confirmPasteTable");
  const pasteLoopIndex = confirmPasteTableBody.indexOf("for (const entry of entries)");
  const refreshLoopIndex = confirmPasteTableBody.indexOf("for (const refreshTarget of refreshTargets.values())");

  assert.notEqual(pasteLoopIndex, -1);
  assert.notEqual(refreshLoopIndex, -1);
  assert.ok(refreshLoopIndex > pasteLoopIndex, "object-list refresh must run after the table paste loop");
  assert.doesNotMatch(confirmPasteTableBody.slice(pasteLoopIndex, refreshLoopIndex), /refreshObjectListTreeNode/);
  assert.match(confirmPasteTableBody.slice(refreshLoopIndex), /refreshObjectListTreeNode\(refreshTarget\.connectionId, refreshTarget\.database, refreshTarget\.schema\)/);
});
