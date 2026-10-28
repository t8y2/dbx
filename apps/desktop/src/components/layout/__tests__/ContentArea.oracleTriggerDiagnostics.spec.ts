// @vitest-environment happy-dom
import { createApp, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import type { ConnectionConfig, ObjectSource } from "@/types/database";
import ContentArea from "../ContentArea.vue";

const rpc = vi.hoisted(() => ({
  getObjectSource: vi.fn(),
  prepareOracleTriggerSql: vi.fn(),
  executeQuery: vi.fn(),
  listCompletionObjects: vi.fn(async () => []),
  listPlugins: vi.fn(async () => []),
  listInstalledAgents: vi.fn(async () => []),
  loadSchemaCache: vi.fn(async () => null),
  saveSchemaCache: vi.fn(async () => undefined),
  deleteSchemaCachePrefix: vi.fn(async () => undefined),
  checkConnectionHealth: vi.fn(async () => undefined),
  saveOpenTabsState: vi.fn(async () => undefined),
}));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), ...rpc }));
let app: App | undefined;
afterEach(() => {
  app?.unmount();
  app = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

it.each(["diagnostics", "failed-refresh", "partial-refresh", "parent"])("keeps the bound trigger source editor through %s", async (scenario) => {
  vi.clearAllMocks();
  rpc.executeQuery.mockReset();
  const pinia = createPinia();
  setActivePinia(pinia);
  i18n.global.locale.value = "en";
  const config = { id: "content-trigger-diagnostic", name: "Trigger source", db_type: "oceanbase-oracle", username: "Execution.Owner", database: "service" } as ConnectionConfig;
  const connection = useConnectionStore();
  connection.connections = [config];
  connection.connectedIds.add(config.id);
  const stored = 'TRIGGER " Trigger.Owner "." Tr""igger " BEFORE INSERT ON "Parent"."T"\nBEGIN\n  missing_proc;\nEND;';
  const raw: ObjectSource = {
    name: ' Tr"igger ',
    schema: " Trigger.Owner ",
    object_type: "TRIGGER",
    source: stored,
    editable: false,
    trigger: {
      name: ' Tr"igger ',
      event: "INSERT",
      timing: "BEFORE",
      enabled: false,
      valid: false,
      oracle_metadata: {
        contractVersion: 1,
        identityMode: "exact",
        engine: "oceanbase-oracle",
        engineVersion: "4.2.5.7_107",
        owner: " Trigger.Owner ",
        name: ' Tr"igger ',
        objectId: "9007199254740993",
        scope: "TABLE",
        parent: { owner: "Parent", name: "T", objectType: "TABLE" },
        definition: { origin: "ALL_SOURCE", format: "declaration", complete: true },
        errors: [{ sequence: 1, line: 3, position: 3, text: "Missing procedure" }],
        reads: { identity: { state: "available" }, scope: { state: "available" }, parent: { state: "available" }, enabled: { state: "available" }, validity: { state: "available" }, definition: { state: "available" }, errors: { state: "available" } },
      },
    },
  };
  rpc.getObjectSource.mockImplementation(async () => JSON.parse(JSON.stringify(raw)));
  rpc.prepareOracleTriggerSql.mockImplementation(async (input) => ({
    definition: input.source.startsWith("TRIGGER") ? "CREATE OR REPLACE " + input.source : input.source,
    comparisonSource: input.source,
    header: { scope: "RELATION", owner: "Parent", name: "T", viewOnly: false, pluggable: false },
    requiresStateRestore: false,
  }));
  const query = useQueryStore();
  const id = query.openObjectSourceTabPending({ connectionId: config.id, database: "service", schema: raw.schema!, catalog: " Catalog ", title: "Trigger source", initialEditing: true, request: { name: raw.name, objectType: "TRIGGER" } });
  await vi.waitFor(() => expect(query.oracleTriggerSourceState(id)?.baseline).toBeDefined());
  const tab = query.tabs.find((candidate) => candidate.id === id)!;
  const dependencyOpen = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({
    render: () =>
      h(ContentArea, {
        activeTab: tab,
        activeConnection: config,
        activeOutputView: "result",
        executableSql: tab.sql,
        formatSqlRequest: null,
        compressSqlRequest: null,
        selectedSql: "",
        cursorPos: 0,
        blockDangerousRedisCommands: false,
        editorOnly: true,
        onEditorUpdate: (tabId: string, sql: string) => query.updateSql(tabId, sql),
        onOpenDependencyObject: dependencyOpen,
      }),
  });
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull(), { timeout: 10_000 });
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
  const original = view.state.doc.toString();
  view.dispatch({ changes: { from: 0, insert: "-- preserve this draft\n" } });
  await nextTick();
  const draft = tab.sql;
  if (scenario === "parent") {
    const { useNavigationTargets } = await import("@/composables/useNavigationTargets");
    const { sqlObjectNavigationContextTarget } = await import("@/lib/sql/sqlNavigation");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.dataTabReuseMode = "same-table";
    const parentId = query.createTab(config.id, "service", "Parent.T", "data", "Parent", undefined, " Catalog ", { forceNew: true });
    query.setTableMeta(parentId, { database: "service", schema: "Parent", catalog: " Catalog ", tableName: "T", tableType: "TABLE", columns: [], primaryKeys: [] });
    query.switchTab(id);
    const navigation = useNavigationTargets({ showFieldLineageDialog: { value: false }, showDatabaseSearchDialog: { value: false }, showDiagramDialog: { value: false } });
    let opened: Promise<void> | undefined;
    dependencyOpen.mockImplementation((context, target) => {
      opened = navigation.openObjectBrowserTableTarget(sqlObjectNavigationContextTarget(target, context));
    });
    [...host.querySelectorAll<HTMLButtonElement>("[data-oracle-trigger-status] button")].find((button) => button.textContent?.includes("Parent.T"))!.click();
    await vi.waitFor(() => expect(dependencyOpen).toHaveBeenCalledOnce());
    await opened;
    expect(dependencyOpen).toHaveBeenCalledWith(expect.objectContaining({ connectionId: config.id, database: "service", catalog: " Catalog ", schema: raw.schema, name: raw.name }), { name: "T", schema: "Parent", type: "table", nameQuoted: true, schemaQuoted: true });
    expect(query.activeTabId).toBe(parentId);
    expect(query.tabs.filter((candidate) => candidate.tableMeta?.tableName === "T")).toHaveLength(1);
    expect(query.tabs.find((candidate) => candidate.id === id)?.sql).toBe(draft);
    expect(query.isTabDirty(tab)).toBe(true);
    expect(EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)).toBe(view);
    expect(rpc.executeQuery).not.toHaveBeenCalled();
    return;
  }
  if (scenario !== "diagnostics") {
    rpc.executeQuery.mockResolvedValue({ columns: ["DIRECTION", "OBJECT_OWNER", "OBJECT_NAME", "OBJECT_TYPE", "REFERENCED_OWNER", "REFERENCED_NAME", "REFERENCED_TYPE", "DEPENDENCY_TYPE", "REFERENCED_LINK_NAME"], rows: [] });
    host.querySelector<HTMLButtonElement>('[data-object-section="dependencies"]')!.click();
    await nextTick();
    const reads = rpc.getObjectSource.mock.calls.length;
    let finish!: (value: ObjectSource) => void;
    let fail!: (error: Error) => void;
    rpc.getObjectSource.mockImplementationOnce(
      () =>
        new Promise<ObjectSource>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    expect(query.refreshObjectSourceTab(id)).toBe(true);
    await vi.waitFor(() => expect(rpc.getObjectSource.mock.calls.length).toBe(reads + 1));
    await nextTick();
    expect(host.querySelector(".cm-editor")).not.toBeNull();
    expect(EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)).toBe(view);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n-- edited during refresh" } });
    await nextTick();
    const latestDraft = tab.sql;
    if (scenario === "failed-refresh") fail(new Error("source permission lost"));
    else {
      const partial = structuredClone(raw);
      partial.trigger!.oracle_metadata!.reads.identity = { state: "denied", message: "identity permission lost" };
      finish(partial);
    }
    await vi.waitFor(() => expect(scenario === "failed-refresh" ? tab.sourceLoad?.error : !tab.sourceLoad).toBeTruthy());
    expect(host.querySelector('[data-object-section="dependencies"]')).not.toBeNull();
    expect(tab.objectDetails?.section).toBe("dependencies");
    host.querySelector<HTMLButtonElement>('[data-object-section="source"]')!.click();
    await nextTick();
    if (scenario === "failed-refresh") expect(host.textContent).toContain("source permission lost");
    else expect(query.oracleTriggerSourceState(id)?.baseline).toBeUndefined();
    expect(EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)).toBe(view);
    expect(tab.sql).toBe(latestDraft);
    expect(view.state.doc.toString()).toBe(latestDraft);
    const { undo } = await import("@codemirror/commands");
    expect(undo(view)).toBe(true);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(original);
    view.dispatch({ changes: { from: 0, insert: "-- new correction after failed read\n" } });
    await nextTick();
    const retryDraft = tab.sql;
    rpc.getObjectSource.mockResolvedValueOnce(structuredClone(raw));
    if (scenario === "failed-refresh") query.retryObjectSourceTab(id);
    else query.refreshObjectSourceTab(id);
    await vi.waitFor(() => expect(tab.sourceLoad).toBeUndefined());
    expect(query.oracleTriggerSourceState(id)?.baseline).toBeDefined();
    expect(EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)).toBe(view);
    expect(tab.sql).toBe(retryDraft);
    expect(view.state.doc.toString()).toBe(retryDraft);
    expect(rpc.executeQuery.mock.calls.every((call) => call[2].includes("ALL_DEPENDENCIES"))).toBe(true);
    return;
  }
  [...host.querySelectorAll<HTMLButtonElement>("[data-oracle-trigger-status] button")].find((button) => button.textContent?.trim() === i18n.global.t("processList.oracleInvalidObjects.errorsTitle"))!.click();
  const locate = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === i18n.global.t("editor.locateError", { line: 3, column: 3 }));
  await vi.waitFor(() => expect(locate()).toBeDefined(), { timeout: 10_000 });
  locate()!.click();
  await vi.waitFor(() => expect(view.state.selection.main.head).toBe(draft.indexOf("missing_proc")));
  expect(tab.sql).toBe(draft);
  expect(query.isTabDirty(tab)).toBe(true);
  expect(EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)).toBe(view);
  expect(tab.editorRevealRequest).toBeUndefined();
  expect(rpc.executeQuery).not.toHaveBeenCalled();
});
