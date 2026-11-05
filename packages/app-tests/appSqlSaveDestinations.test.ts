import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import { computed, nextTick, ref } from "vue";
import ts from "typescript";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useSaveSqlFolderSelection } from "../../apps/desktop/src/composables/useSaveSqlFolderSelection.ts";
import { isObjectDependencySection } from "../../apps/desktop/src/lib/database/objectDependencyDetails.ts";
import { effectiveDatabaseTypeForConnection } from "../../apps/desktop/src/lib/database/jdbcDialect.ts";
import { savedSqlErrorMessage } from "../../apps/desktop/src/lib/savedSql/savedSqlErrors.ts";
import { savedSqlDefaultTargetForWrite } from "../../apps/desktop/src/lib/savedSql/savedSqlExecutionTarget.ts";
import { defaultSavedQueryFileName, sqlFileTitleFromPath } from "../../apps/desktop/src/lib/sql/sqlFileOpen.ts";
import { canSaveSqlTab, type SqlSaveDestination } from "../../apps/desktop/src/lib/tabs/sqlTabSaveTarget.ts";
import { useQueryStore } from "../../apps/desktop/src/stores/queryStore.ts";
import { useSavedSqlStore } from "../../apps/desktop/src/stores/savedSqlStore.ts";
import { useSettingsStore } from "../../apps/desktop/src/stores/settingsStore.ts";
import type { QueryTab, SavedSqlFile } from "../../apps/desktop/src/types/database.ts";

const io = vi.hoisted(() => ({
  desktop: true,
  loadSavedSqlLibrary: vi.fn(),
  saveSavedSqlFile: vi.fn<(file: SavedSqlFile) => Promise<SavedSqlFile>>(),
  saveSavedSqlEditorPositions: vi.fn(),
  saveExternalSqlFile: vi.fn(),
  writeExternalSqlFile: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/backend/api", () => ({
  loadSavedSqlLibrary: io.loadSavedSqlLibrary,
  saveSavedSqlFile: io.saveSavedSqlFile,
  saveSavedSqlEditorPositions: io.saveSavedSqlEditorPositions,
  saveExternalSqlFile: io.saveExternalSqlFile,
  writeExternalSqlFile: io.writeExternalSqlFile,
  closeClientConnectionSession: io.closeClientConnectionSession,
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => io.desktop }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: io.toast }) }));

// Execute the actual App handlers without mounting the entire application. The
// stores, routing, name conflict handling, and target-link methods remain real;
// the native save dialog / disk and SQL-library persistence are IO boundaries.
const appSource = readFileSync(new URL("../../apps/desktop/src/App.vue", import.meta.url), "utf8");
const script = appSource.slice(appSource.indexOf(">") + 1, appSource.indexOf("</script>"));
const sourceFile = ts.createSourceFile("App.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const requiredFunctions = [
  "openSaveSqlDialog",
  "confirmSaveSqlToLibrary",
  "saveExternalSqlTabAs",
  "saveExternalSqlPath",
  "writeExternalSqlTab",
  "formattedSqlForSave",
  "savedSqlTargetForSave",
  "saveSqlDialogTab",
  "defaultSavedSqlName",
  "setAutoSaveSqlName",
  "selectedSaveSqlFolderId",
  "autoAdjustedSaveName",
  "cancelPendingSaveAndClose",
  "closePendingSavedTab",
  "runSqlTabSave",
  "saveActiveSqlAsLocalFile",
  "saveTabForCloseAll",
  "handleSaveTab",
  "completePendingTabSave",
];
const declarations = new Map(
  sourceFile.statements
    .filter(ts.isFunctionDeclaration)
    .filter((statement) => statement.name)
    .map((statement) => [statement.name!.text, statement]),
);
for (const name of requiredFunctions) assert.ok(declarations.has(name), `App handler ${name} exists`);
const handlerNames = requiredFunctions;
const handlerSource = ts.transpileModule(handlerNames.map((name) => declarations.get(name)!.getText(sourceFile)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

const version = { contentHash: "saved-content", modifiedNs: "1", sizeBytes: 9 };
const disposals: Array<() => void> = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  io.desktop = true;
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  setActivePinia(createPinia());
  io.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [] });
  io.saveSavedSqlFile.mockImplementation(async (file) => ({ ...file }));
  io.saveSavedSqlEditorPositions.mockResolvedValue(undefined);
  io.saveExternalSqlFile.mockResolvedValue({ path: "/tmp/destination.sql", version });
  io.writeExternalSqlFile.mockResolvedValue({ kind: "written", version });
  io.closeClientConnectionSession.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function harness() {
  const queryStore = useQueryStore();
  const savedSqlStore = useSavedSqlStore();
  const settingsStore = useSettingsStore();
  settingsStore.editorSettings.formatSqlOnSqlFileSave = false;
  disposals.push(
    () => queryStore.$dispose(),
    () => savedSqlStore.$dispose(),
    () => settingsStore.$dispose(),
  );
  const folder = useSaveSqlFolderSelection("__root__");
  const state = {
    activeTab: computed(() => queryStore.tabs.find((tab) => tab.id === queryStore.activeTabId)),
    showSaveSqlDialog: ref(false),
    saveSqlDialogTabId: ref<string | null>(null),
    saveSqlName: ref(""),
    autoGeneratedSaveSqlName: ref<string | null>(null),
    sqlLibrarySaveFeedbackId: ref(0),
    pendingSaveAndCloseTabId: ref<string | null>(null),
    pendingPrevActiveTabId: ref<string | null>(null),
    pendingSaveShouldCloseTab: ref(true),
    pendingAppCloseAction: ref<string | null>(null),
    sqlSaveInFlight: new Set<string>(),
    saveSqlFolderId: folder.selection,
    saveSqlFolderCreationPending: folder.pending,
    isCreatingSaveSqlFolder: folder.isCreating,
    saveSqlNewFolderName: folder.newFolderName,
  };
  const prepareSave = vi.fn(async () => ({ proceed: true, expectedContentHash: "previous-content" }));
  const saveActiveObjectSource = vi.fn(async () => true);
  const bindings = {
    ...state,
    queryStore,
    savedSqlStore,
    settingsStore,
    connectionStore: { getConfig: (id: string) => ({ id, db_type: "mysql" }) },
    canSaveSqlTab,
    isObjectDependencySection,
    effectiveDatabaseTypeForConnection,
    savedSqlDefaultTargetForWrite,
    savedSqlErrorMessage,
    defaultSavedQueryFileName,
    sqlFileTitleFromPath,
    isTauriRuntime: () => io.desktop,
    isDesktop: io.desktop,
    api: io,
    externalSqlFileChanges: { prepareSave },
    saveActiveObjectSource,
    ROOT_SAVED_SQL_FOLDER: "__root__",
    SAVE_SQL_NAME_ATTEMPTS: 3,
    resetSaveSqlFolderSelection: folder.reset,
    invalidateSaveSqlFolderSelection: folder.invalidate,
    cancelCreateSaveSqlFolder: folder.cancelCreating,
    cancelPendingAppClose: vi.fn(),
    continuePendingAppCloseAfterSave: vi.fn(),
    contentAreaRef: ref(null),
    nextTick,
    rememberExternalSqlFileTarget: vi.fn(),
    elementCenter: () => null,
    saveSqlConfirmButtonElement: () => null,
    notifySqlLibrarySaved: vi.fn(),
    notifyNewSqlLibrarySaved: vi.fn(),
    toast: io.toast,
    t: (key: string, params?: { message?: string }) => (params?.message ? `${key}: ${params.message}` : key),
  };
  const handlers = new Function(...Object.keys(bindings), `${handlerSource}\nreturn { openSaveSqlDialog, confirmSaveSqlToLibrary, cancelPendingSaveAndClose, saveTabForCloseAll, handleSaveTab };`)(...Object.values(bindings)) as {
    openSaveSqlDialog: (tabId?: string, destination?: SqlSaveDestination) => Promise<void>;
    confirmSaveSqlToLibrary: () => Promise<void>;
    cancelPendingSaveAndClose: () => void;
    saveTabForCloseAll: (tabId: string) => Promise<boolean>;
    handleSaveTab: (tabId: string) => Promise<void>;
  };
  function newTab(sql = "SELECT 1;", title = "report") {
    const id = queryStore.createTab("conn-1", "demo", title, "query", undefined, sql, undefined, { forceNew: true });
    return queryStore.tabs.find((tab) => tab.id === id)!;
  }
  function localTab() {
    const tab = newTab();
    queryStore.linkExternalSqlPath(tab.id, "/tmp/original.sql", "original.sql", version, "utf8");
    queryStore.updateSql(tab.id, "SELECT 2;");
    return tab;
  }
  async function libraryTab() {
    const file = await savedSqlStore.saveFile({ name: "library.sql", connectionId: "conn-1", database: "demo", folderId: "folder-1", sql: "SELECT 1;" });
    const tab = newTab(file.sql, file.name);
    queryStore.linkSavedSql(tab.id, file.id, file.name);
    queryStore.markTabClean(tab);
    queryStore.updateSql(tab.id, "SELECT 2;");
    io.saveSavedSqlFile.mockClear();
    return { tab, file };
  }
  return { ...state, ...handlers, queryStore, savedSqlStore, newTab, localTab, libraryTab, prepareSave, saveActiveObjectSource };
}

function target(tab: QueryTab) {
  return { savedSqlId: tab.savedSqlId, externalSqlPath: tab.externalSqlPath, externalSqlEncoding: tab.externalSqlEncoding, externalSqlFileVersion: tab.externalSqlFileVersion, originalSql: tab.originalSql };
}

test("a local SQL tab saves to the library, then default save updates the same library entry", async () => {
  const context = harness();
  const tab = context.localTab();
  await context.openSaveSqlDialog(tab.id, "library");
  assert.equal(context.showSaveSqlDialog.value, true);
  assert.equal(tab.externalSqlPath, "/tmp/original.sql");
  assert.equal(io.writeExternalSqlFile.mock.calls.length, 0);
  context.saveSqlFolderId.value = "folder-1";
  await context.confirmSaveSqlToLibrary();
  const id = tab.savedSqlId;
  assert.ok(id);
  assert.equal(tab.externalSqlPath, undefined);
  assert.equal(tab.externalSqlEncoding, undefined);
  assert.equal(tab.externalSqlFileVersion, undefined);
  assert.equal(context.queryStore.isTabDirty(tab), false);
  context.queryStore.updateSql(tab.id, "SELECT 3;");
  await context.openSaveSqlDialog(tab.id);
  assert.equal(context.savedSqlStore.files.length, 1);
  assert.equal(context.savedSqlStore.getFile(id)?.sql, "SELECT 3;");
  assert.equal(context.savedSqlStore.getFile(id)?.folderId, "folder-1");
  assert.equal(tab.savedSqlId, id);
  assert.equal(io.writeExternalSqlFile.mock.calls.length, 0);
});

test("a library SQL tab saves to a local file, then default save writes the new path only", async () => {
  const context = harness();
  const { tab, file } = await context.libraryTab();
  await context.openSaveSqlDialog(tab.id, "local");
  assert.equal(tab.savedSqlId, undefined);
  assert.equal(tab.externalSqlPath, "/tmp/destination.sql");
  assert.equal(context.queryStore.isTabDirty(tab), false);
  assert.equal(context.savedSqlStore.getFile(file.id)?.sql, "SELECT 1;");
  context.queryStore.updateSql(tab.id, "SELECT 3;");
  await context.openSaveSqlDialog(tab.id);
  assert.deepEqual(io.writeExternalSqlFile.mock.calls[0], ["/tmp/destination.sql", "SELECT 3;", { expectedContentHash: "previous-content", expectedMissing: undefined, encoding: "utf8" }]);
  assert.equal(io.saveSavedSqlFile.mock.calls.length, 0);
});

test("explicit library save updates the original ID and preserves its folder", async () => {
  const context = harness();
  const { tab, file } = await context.libraryTab();
  await context.openSaveSqlDialog(tab.id, "library");
  context.queryStore.updateSql(tab.id, "SELECT 3;");
  await context.openSaveSqlDialog(tab.id, "library");
  assert.equal(context.savedSqlStore.files.length, 1);
  assert.equal(tab.savedSqlId, file.id);
  assert.equal(context.savedSqlStore.getFile(file.id)?.folderId, "folder-1");
  assert.equal(context.savedSqlStore.getFile(file.id)?.sql, "SELECT 3;");
  assert.equal(context.showSaveSqlDialog.value, false);
  assert.deepEqual(
    io.saveSavedSqlFile.mock.calls.map(([saved]) => saved.id),
    [file.id, file.id],
  );
});

test.each(["cancel", "failure"])("a %s in the native local save keeps the library binding and dirty draft", async (outcome) => {
  const context = harness();
  const { tab } = await context.libraryTab();
  const original = target(tab);
  if (outcome === "cancel") io.saveExternalSqlFile.mockResolvedValueOnce(null);
  else io.saveExternalSqlFile.mockRejectedValueOnce(new Error("disk full"));
  await context.openSaveSqlDialog(tab.id, "local");
  assert.deepEqual(target(tab), original);
  assert.equal(context.queryStore.isTabDirty(tab), true);
  assert.equal(io.saveSavedSqlFile.mock.calls.length, 0);
});

test("cancelling a library destination dialog keeps the local target and unsaved contents", async () => {
  const context = harness();
  const tab = context.localTab();
  const original = target(tab);
  await context.openSaveSqlDialog(tab.id, "library");
  context.cancelPendingSaveAndClose();
  assert.equal(context.showSaveSqlDialog.value, false);
  assert.deepEqual(target(tab), original);
  assert.equal(context.queryStore.isTabDirty(tab), true);
  assert.equal(io.saveSavedSqlFile.mock.calls.length, 0);
});

test("a failed library write leaves the local binding retryable", async () => {
  const context = harness();
  const tab = context.localTab();
  const original = target(tab);
  await context.openSaveSqlDialog(tab.id, "library");
  io.saveSavedSqlFile.mockRejectedValueOnce(new Error("library unavailable"));
  await context.confirmSaveSqlToLibrary();
  assert.deepEqual(target(tab), original);
  assert.equal(context.showSaveSqlDialog.value, true);
  assert.equal(context.savedSqlStore.files.length, 0);
  await context.confirmSaveSqlToLibrary();
  assert.ok(tab.savedSqlId);
  assert.equal(tab.externalSqlPath, undefined);
  assert.equal(context.savedSqlStore.files.length, 1);
});

test("an existing local target uses its conflict-aware write and never falls back to the library", async () => {
  const context = harness();
  const tab = context.localTab();
  const original = target(tab);
  io.writeExternalSqlFile.mockRejectedValueOnce(new Error("read-only disk"));
  await context.openSaveSqlDialog(tab.id, "local");
  assert.equal(context.prepareSave.mock.calls.length, 1);
  assert.equal(io.writeExternalSqlFile.mock.calls.length, 1);
  assert.equal(io.saveExternalSqlFile.mock.calls.length, 0);
  assert.equal(io.saveSavedSqlFile.mock.calls.length, 0);
  assert.equal(context.showSaveSqlDialog.value, false);
  assert.deepEqual(target(tab), original);
});

test.each(["local", "library"] as const)("a new nonempty script can choose %s directly", async (destination) => {
  const context = harness();
  const tab = context.newTab();
  await context.openSaveSqlDialog(tab.id, destination);
  if (destination === "library") {
    assert.equal(context.showSaveSqlDialog.value, true);
    await context.confirmSaveSqlToLibrary();
    assert.ok(tab.savedSqlId);
    assert.equal(io.saveExternalSqlFile.mock.calls.length, 0);
  } else {
    assert.equal(context.showSaveSqlDialog.value, false);
    assert.equal(tab.externalSqlPath, "/tmp/destination.sql");
    assert.equal(io.saveSavedSqlFile.mock.calls.length, 0);
  }
  assert.equal(context.queryStore.isTabDirty(tab), false);
});

test("a pending local destination belongs to its initiating tab when the active tab changes", async () => {
  const context = harness();
  const { tab } = await context.libraryTab();
  const pending = deferred<{ path: string; version: typeof version }>();
  io.saveExternalSqlFile.mockReturnValueOnce(pending.promise);
  const save = context.openSaveSqlDialog(tab.id, "local");
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
  assert.equal(io.saveExternalSqlFile.mock.calls.length, 1);
  const other = context.newTab("SELECT 99;", "other");
  context.queryStore.activateTab(other.id);
  pending.resolve({ path: "/tmp/captured-tab.sql", version });
  await save;
  assert.equal(tab.externalSqlPath, "/tmp/captured-tab.sql");
  assert.equal(other.externalSqlPath, undefined);
  assert.equal(other.savedSqlId, undefined);
  assert.equal(io.saveExternalSqlFile.mock.calls[0]?.[1], "SELECT 2;");
});

test("a library confirmation keeps its initiating tab when another editor becomes active", async () => {
  const context = harness();
  const tab = context.localTab();
  await context.openSaveSqlDialog(tab.id, "library");
  const other = context.newTab("SELECT 99;", "other");
  context.queryStore.activateTab(other.id);
  await context.confirmSaveSqlToLibrary();
  assert.ok(tab.savedSqlId);
  assert.equal(tab.externalSqlPath, undefined);
  assert.equal(other.savedSqlId, undefined);
  assert.equal(context.savedSqlStore.getFile(tab.savedSqlId)?.sql, "SELECT 2;");
});

test.each(["local", "library"] as const)("an empty new script cannot save to %s", async (destination) => {
  const context = harness();
  const tab = context.newTab("");
  await context.openSaveSqlDialog(tab.id, destination);
  assert.equal(context.showSaveSqlDialog.value, false);
  assert.equal(io.saveExternalSqlFile.mock.calls.length, 0);
  assert.equal(io.saveSavedSqlFile.mock.calls.length, 0);
});

test.each(["local", "library"] as const)("explicit %s destination cannot submit an object source as DDL", async (destination) => {
  const context = harness();
  const tab = context.newTab("CREATE VIEW reports AS SELECT 1;");
  tab.objectSource = { name: "reports", objectType: "VIEW", schema: "demo" };
  await context.openSaveSqlDialog(tab.id, destination);
  assert.equal(context.saveActiveObjectSource.mock.calls.length, 0);
  assert.equal(io.saveExternalSqlFile.mock.calls.length, 0);
  assert.equal(io.saveSavedSqlFile.mock.calls.length, 0);
  assert.equal(context.showSaveSqlDialog.value, false);
  await context.openSaveSqlDialog(tab.id);
  assert.equal(context.saveActiveObjectSource.mock.calls.length, 1);
});

test("a pending native save blocks a second destination for the same tab", async () => {
  const context = harness();
  const tab = context.newTab();
  const pending = deferred<{ path: string; version: typeof version }>();
  io.saveExternalSqlFile.mockReturnValueOnce(pending.promise);
  const save = context.openSaveSqlDialog(tab.id, "local");
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
  await context.openSaveSqlDialog(tab.id, "library");
  assert.equal(io.saveExternalSqlFile.mock.calls.length, 1);
  assert.equal(io.saveSavedSqlFile.mock.calls.length, 0);
  assert.equal(context.showSaveSqlDialog.value, false);
  pending.resolve({ path: "/tmp/single-destination.sql", version });
  await save;
  assert.equal(tab.externalSqlPath, "/tmp/single-destination.sql");
  assert.equal(tab.savedSqlId, undefined);
  assert.equal(context.sqlSaveInFlight.size, 0);
});

test("repeated confirmation while a library write is pending creates one entry", async () => {
  const context = harness();
  const tab = context.localTab();
  await context.openSaveSqlDialog(tab.id, "library");
  const pending = deferred<SavedSqlFile>();
  io.saveSavedSqlFile.mockReturnValueOnce(pending.promise);
  const save = context.confirmSaveSqlToLibrary();
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
  await context.confirmSaveSqlToLibrary();
  assert.equal(io.saveSavedSqlFile.mock.calls.length, 1);
  pending.resolve(io.saveSavedSqlFile.mock.calls[0]![0]);
  await save;
  assert.equal(context.savedSqlStore.files.length, 1);
  assert.equal(tab.savedSqlId, context.savedSqlStore.files[0]?.id);
  assert.equal(context.sqlSaveInFlight.size, 0);
});

test("save-all cannot overwrite the binding while an explicit local save is pending", async () => {
  const context = harness();
  const { tab } = await context.libraryTab();
  const pending = deferred<{ path: string; version: typeof version }>();
  io.saveExternalSqlFile.mockReturnValueOnce(pending.promise);
  const save = context.openSaveSqlDialog(tab.id, "local");
  await vi.waitFor(() => assert.equal(io.saveExternalSqlFile.mock.calls.length, 1));

  assert.equal(await context.saveTabForCloseAll(tab.id), false);
  assert.equal(io.saveSavedSqlFile.mock.calls.length, 0);
  assert.ok(context.queryStore.tabs.some((candidate) => candidate.id === tab.id));

  pending.resolve({ path: "/tmp/local-before-save-all.sql", version });
  await save;
  assert.equal(tab.externalSqlPath, "/tmp/local-before-save-all.sql");
  assert.equal(tab.savedSqlId, undefined);
  assert.equal(context.sqlSaveInFlight.size, 0);
});

test.each(["save-all", "save-and-close"] as const)("%s holds the same lock as explicit destinations", async (source) => {
  const context = harness();
  const { tab } = await context.libraryTab();
  const pending = deferred<SavedSqlFile>();
  io.saveSavedSqlFile.mockReturnValueOnce(pending.promise);
  const save = source === "save-all" ? context.saveTabForCloseAll(tab.id) : context.handleSaveTab(tab.id);
  await vi.waitFor(() => assert.equal(io.saveSavedSqlFile.mock.calls.length, 1));

  await context.openSaveSqlDialog(tab.id, "local");
  assert.equal(io.saveExternalSqlFile.mock.calls.length, 0);
  assert.equal(context.sqlSaveInFlight.has(tab.id), true);

  pending.resolve(io.saveSavedSqlFile.mock.calls[0]![0]);
  await save;
  assert.equal(context.sqlSaveInFlight.size, 0);
  assert.equal(tab.externalSqlPath, undefined);
  assert.equal(
    io.toast.mock.calls.some(([message]) => String(message).includes("savedSql.saveFailed")),
    false,
    JSON.stringify(io.toast.mock.calls),
  );
  assert.equal(
    context.queryStore.tabs.some((candidate) => candidate.id === tab.id),
    source === "save-all",
  );
});

test.each(["tab", "app"] as const)("a pending destination save restores the %s close confirmation without another write", async (scope) => {
  const context = harness();
  const { tab } = await context.libraryTab();
  useSettingsStore().editorSettings.confirmUnsavedSqlClose = true;
  useSettingsStore().editorSettings.appCloseUnsavedTabsMode = "prompt";
  const pending = deferred<{ path: string; version: typeof version }>();
  io.saveExternalSqlFile.mockReturnValueOnce(pending.promise);
  const save = context.openSaveSqlDialog(tab.id, "local");
  await vi.waitFor(() => assert.equal(io.saveExternalSqlFile.mock.calls.length, 1));

  if (scope === "app") {
    context.pendingAppCloseAction.value = "quit";
    assert.equal(context.queryStore.requestAppCloseConfirmation(), true);
  } else context.queryStore.closeTab(tab.id);
  assert.equal(context.queryStore.saveAndClosePendingTab(), tab.id);
  assert.equal(context.queryStore.pendingCloseTabId, null);

  await context.handleSaveTab(tab.id);
  assert.equal(context.queryStore.showCloseConfirm, true);
  assert.equal(context.queryStore.pendingCloseTabId, tab.id);
  assert.equal(context.queryStore.isConfirmingAppClose, scope === "app");
  assert.equal(io.saveSavedSqlFile.mock.calls.length, 0);

  pending.resolve({ path: "/tmp/local-before-close.sql", version });
  await save;
  assert.ok(context.queryStore.tabs.some((candidate) => candidate.id === tab.id));
  assert.equal(tab.externalSqlPath, "/tmp/local-before-close.sql");
  assert.equal(tab.savedSqlId, undefined);
  assert.equal(context.sqlSaveInFlight.size, 0);
});

test("a save-all failure releases the lock for an explicit destination retry", async () => {
  const context = harness();
  const { tab, file } = await context.libraryTab();
  io.saveSavedSqlFile.mockRejectedValueOnce(new Error("library unavailable"));
  assert.equal(await context.saveTabForCloseAll(tab.id), false);
  assert.equal(context.sqlSaveInFlight.size, 0);
  assert.equal(tab.savedSqlId, file.id);

  await context.openSaveSqlDialog(tab.id, "local");
  assert.equal(tab.externalSqlPath, "/tmp/destination.sql");
  assert.equal(tab.savedSqlId, undefined);
});

test.each(["local", "library"] as const)("finishing a %s save cannot dismiss or close another tab awaiting its own save", async (destination) => {
  const context = harness();
  const first = destination === "local" ? (await context.libraryTab()).tab : context.localTab();
  const pendingLocal = deferred<{ path: string; version: typeof version }>();
  const pendingLibrary = deferred<SavedSqlFile>();
  let save: Promise<void>;
  if (destination === "local") {
    io.saveExternalSqlFile.mockReturnValueOnce(pendingLocal.promise);
    save = context.openSaveSqlDialog(first.id, "local");
    await vi.waitFor(() => assert.equal(io.saveExternalSqlFile.mock.calls.length, 1));
  } else {
    await context.openSaveSqlDialog(first.id, "library");
    io.saveSavedSqlFile.mockReturnValueOnce(pendingLibrary.promise);
    save = context.confirmSaveSqlToLibrary();
    await vi.waitFor(() => assert.equal(io.saveSavedSqlFile.mock.calls.length, 1));
    context.cancelPendingSaveAndClose();
  }

  const second = context.newTab("SELECT 1;", "second");
  context.queryStore.updateSql(second.id, "SELECT 'not yet saved';");
  useSettingsStore().editorSettings.confirmUnsavedSqlClose = true;
  context.queryStore.closeTab(second.id);
  assert.equal(context.queryStore.saveAndClosePendingTab(), second.id);
  await context.handleSaveTab(second.id);
  assert.equal(context.showSaveSqlDialog.value, true);
  assert.equal(context.pendingSaveAndCloseTabId.value, second.id);
  context.saveSqlFolderId.value = "second-folder";

  if (destination === "local") pendingLocal.resolve({ path: "/tmp/first.sql", version });
  else pendingLibrary.resolve(io.saveSavedSqlFile.mock.calls[0]![0]);
  await save;

  assert.ok(context.queryStore.tabs.some((tab) => tab.id === second.id));
  assert.equal(second.savedSqlId, undefined);
  assert.equal(context.showSaveSqlDialog.value, true);
  assert.equal(context.saveSqlDialogTabId.value, second.id);
  assert.equal(context.pendingSaveAndCloseTabId.value, second.id);
  assert.equal(context.saveSqlFolderId.value, "second-folder");

  await context.confirmSaveSqlToLibrary();
  const secondFile = context.savedSqlStore.files.find((file) => file.name === "second.sql");
  assert.equal(secondFile?.sql, "SELECT 'not yet saved';");
  assert.equal(secondFile?.folderId, "second-folder");
  assert.equal(
    context.queryStore.tabs.some((tab) => tab.id === second.id),
    false,
  );
  assert.ok(context.queryStore.tabs.some((tab) => tab.id === first.id));
  assert.equal(context.showSaveSqlDialog.value, false);
  assert.equal(context.sqlSaveInFlight.size, 0);
});

test("library confirmation captures its folder before awaiting the SQL to save", async () => {
  const context = harness();
  const first = context.localTab();
  await context.openSaveSqlDialog(first.id, "library");
  context.saveSqlFolderId.value = "first-folder";
  const savingFirst = context.confirmSaveSqlToLibrary();
  context.cancelPendingSaveAndClose();

  const second = context.newTab("SELECT 99;", "second");
  const openingSecond = context.openSaveSqlDialog(second.id, "library");
  context.saveSqlFolderId.value = "second-folder";
  await Promise.all([savingFirst, openingSecond]);

  assert.equal(context.savedSqlStore.getFile(first.savedSqlId!)?.folderId, "first-folder");
  assert.equal(context.saveSqlDialogTabId.value, second.id);
  assert.equal(context.saveSqlFolderId.value, "second-folder");
  assert.equal(context.showSaveSqlDialog.value, true);
});

test("an old library save retries its own generated name without changing the next dialog", async () => {
  const context = harness();
  const first = context.localTab();
  await context.openSaveSqlDialog(first.id, "library");
  context.saveSqlFolderId.value = "first-folder";
  const pending = deferred<SavedSqlFile>();
  io.saveSavedSqlFile.mockReturnValueOnce(pending.promise);
  const savingFirst = context.confirmSaveSqlToLibrary();
  await vi.waitFor(() => assert.equal(io.saveSavedSqlFile.mock.calls.length, 1));
  context.cancelPendingSaveAndClose();

  const second = context.newTab("SELECT 99;", "second");
  await context.openSaveSqlDialog(second.id, "library");
  context.saveSqlName.value = "chosen-by-user.sql";
  context.saveSqlFolderId.value = "second-folder";
  pending.reject(Object.assign(new Error("name conflict"), { code: "SAVED_SQL_NAME_CONFLICT", suggestedName: "original_2.sql" }));
  await savingFirst;

  assert.equal(context.savedSqlStore.getFile(first.savedSqlId!)?.name, "original_2.sql");
  assert.deepEqual(
    io.saveSavedSqlFile.mock.calls.map(([file]) => file.folderId),
    ["first-folder", "first-folder"],
  );
  assert.equal(context.saveSqlName.value, "chosen-by-user.sql");
  assert.equal(context.autoGeneratedSaveSqlName.value, "second.sql");
  assert.equal(context.saveSqlFolderId.value, "second-folder");
  assert.equal(context.saveSqlDialogTabId.value, second.id);
  assert.equal(context.showSaveSqlDialog.value, true);
});

test("an emptied existing local SQL file can be saved to the library", async () => {
  const context = harness();
  const tab = context.localTab();
  context.queryStore.updateSql(tab.id, "");
  await context.openSaveSqlDialog(tab.id, "library");
  assert.equal(context.showSaveSqlDialog.value, true);
  await context.confirmSaveSqlToLibrary();
  assert.ok(tab.savedSqlId);
  assert.equal(context.savedSqlStore.getFile(tab.savedSqlId)?.sql, "");
  assert.equal(tab.externalSqlPath, undefined);
  assert.equal(context.queryStore.isTabDirty(tab), false);
});

test("the local destination is unavailable outside the desktop runtime", async () => {
  io.desktop = false;
  const context = harness();
  const tab = context.newTab();
  await context.openSaveSqlDialog(tab.id, "local");
  assert.equal(io.saveExternalSqlFile.mock.calls.length, 0);
  assert.equal(io.saveSavedSqlFile.mock.calls.length, 0);
  assert.equal(context.showSaveSqlDialog.value, false);
  assert.equal(tab.externalSqlPath, undefined);
});

test.each(["structure", "sourceLoad"] as const)("explicit destinations leave %s editor persistence untouched", async (kind) => {
  const context = harness();
  const tab = context.newTab("CREATE TABLE test (id INT);");
  if (kind === "structure") tab.mode = "structure";
  else tab.sourceLoad = { request: { name: "test", objectType: "VIEW" } } as NonNullable<QueryTab["sourceLoad"]>;
  await context.openSaveSqlDialog(tab.id, "local");
  await context.openSaveSqlDialog(tab.id, "library");
  assert.equal(context.saveActiveObjectSource.mock.calls.length, 0);
  assert.equal(io.saveExternalSqlFile.mock.calls.length, 0);
  assert.equal(io.saveSavedSqlFile.mock.calls.length, 0);
  assert.equal(context.showSaveSqlDialog.value, false);
});
