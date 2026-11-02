// @vitest-environment happy-dom
import { createApp, h, nextTick, type App } from "vue";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ObjectBrowser from "../ObjectBrowser.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import i18n from "@/i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSqlExecutionDangerStore } from "@/stores/sqlExecutionDangerStore";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import { invalidateObjectMetadataCache } from "@/lib/metadata/objectMetadataCache";
import type { ConnectionConfig, ObjectSource } from "@/types/database";

const rpc = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn(),
  getObjectSource: vi.fn(),
  executeQuery: vi.fn(),
  prepareOracleTriggerSql: vi.fn(),
  buildDropObjectSql: vi.fn(),
  buildDropTableSql: vi.fn(),
  listForeignKeys: vi.fn(async () => []),
  listPlugins: vi.fn(async () => []),
  listInstalledAgents: vi.fn(async () => []),
  loadSchemaCache: vi.fn(async () => null),
  saveSchemaCache: vi.fn(async () => undefined),
  deleteSchemaCachePrefix: vi.fn(async () => undefined),
  listObjectStatistics: vi.fn(async () => []),
  checkConnectionHealth: vi.fn(async () => undefined),
  saveOpenTabsState: vi.fn(async () => undefined),
  saveHistory: vi.fn(async () => undefined),
  cancelQuery: vi.fn(async () => true),
}));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), ...rpc }));
const owner = " Trigger.Owner ",
  name = ' Tr"ig ',
  parentOwner = " Parent.Owner ",
  parentName = " View ",
  executionSchema = "Browse.Owner";
const config = { id: "browser-exact-trigger-actions", name: "Trigger browser", db_type: "oceanbase-oracle", username: executionSchema, database: "service" } as ConnectionConfig;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const dropSql = (triggerOwner: string) => `DROP TRIGGER ${quote(triggerOwner)}.${quote(name)};`;
let raw: ObjectSource;
let app: App | undefined;
const openDependencyObject = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks();
  invalidateObjectBrowserRowsCache({});
  await invalidateObjectMetadataCache({ connectionId: config.id });
  i18n.global.locale.value = "en";
  raw = {
    name,
    schema: owner,
    object_type: "TRIGGER",
    source: "BEGIN NULL; END;",
    editable: false,
    trigger: {
      name,
      timing: "INSTEAD OF",
      event: "INSERT",
      statement: "BEGIN NULL; END;",
      enabled: false,
      valid: false,
      oracle_metadata: {
        contractVersion: 1,
        identityMode: "exact",
        engine: "oceanbase-oracle",
        engineVersion: "4.2.5.7_107",
        owner,
        name,
        objectId: "trigger-id",
        scope: "VIEW",
        parent: { owner: parentOwner, name: parentName, objectType: "VIEW" },
        definition: { origin: "catalog-body", format: "body", complete: false },
        errors: [{ sequence: 1, line: 3, position: 7, text: "Missing procedure" }],
        reads: { identity: { state: "available" }, scope: { state: "available" }, parent: { state: "available" }, enabled: { state: "available" }, validity: { state: "available" }, definition: { state: "denied" }, errors: { state: "available" } },
      },
    },
  };
  rpc.listSchemas.mockReset().mockResolvedValue([executionSchema]);
  rpc.listObjects.mockReset().mockImplementation(async () => [{ name, schema: owner, object_type: "TRIGGER", valid: raw.trigger!.valid, trigger: JSON.parse(JSON.stringify(raw.trigger)) }]);
  rpc.getObjectSource.mockReset().mockImplementation(async () => JSON.parse(JSON.stringify(raw)));
  rpc.buildDropObjectSql.mockReset().mockImplementation(async (input) => `DROP ${input.objectType} ${quote(input.schema)}.${quote(input.name)};`);
  rpc.buildDropTableSql.mockReset().mockImplementation(async (input) => `DROP TABLE ${quote(input.schema)}.${quote(input.tableName)};`);
  rpc.executeQuery.mockReset().mockImplementation(async (_id, _db, sql: string) => {
    if (sql.endsWith(" ENABLE;")) raw.trigger!.enabled = true;
    if (sql.endsWith(" DISABLE;")) raw.trigger!.enabled = false;
    return { columns: [], rows: [], affected_rows: 0 };
  });
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountTriggerBrowser(filter: "all" | "triggers" = "triggers", connection = config) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connections = useConnectionStore();
  connections.connections = [connection];
  connections.connectedIds.add(connection.id);
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(TooltipProvider, {}, { default: () => h(ObjectBrowser, { connection, database: "service", schema: executionSchema, catalog: " Catalog ", selectedObjectFilter: filter, onOpenDependencyObject: openDependencyObject }) }) });
  app.use(pinia);
  app.use(i18n);
  app.component("LightTooltip", LightTooltip);
  app.mount(host);
  await vi.waitFor(() => expect([...host.querySelectorAll<HTMLElement>("[title]")].some((item) => item.title === name)).toBe(true));
  return host;
}

it.each(["native", "oracle-jdbc", "dm-jdbc"])("reuses dependency sections in the %s source panel without destroying its draft, undo or exact navigation context", async (provider) => {
  raw.source = `CREATE OR REPLACE TRIGGER ${quote(owner)}.${quote(name)} INSTEAD OF INSERT ON ${quote(parentOwner)}.${quote(parentName)} DISABLE BEGIN NULL; END;`;
  raw.trigger!.oracle_metadata!.definition = { origin: "DBMS_METADATA", format: "ddl", complete: true };
  raw.trigger!.oracle_metadata!.reads.definition = { state: "available" };
  const connection = provider === "native" ? config : { ...config, db_type: "jdbc" as const, driver_profile: provider === "dm-jdbc" ? "dameng" : "oracle", database_info: { productName: provider === "dm-jdbc" ? "DM DBMS" : "Oracle" } };
  if (provider !== "native") {
    raw.trigger!.oracle_metadata!.engine = provider === "dm-jdbc" ? "dm" : "oracle";
    raw.trigger!.oracle_metadata!.engineVersion = provider === "dm-jdbc" ? "8.1" : "19.0";
  }
  rpc.prepareOracleTriggerSql.mockImplementation(async (input) => ({ definition: input.source, comparisonSource: input.source, header: { scope: "RELATION", owner: parentOwner, name: parentName, viewOnly: true, pluggable: false }, requiresStateRestore: false }));
  rpc.executeQuery.mockResolvedValue({
    columns: ["DIRECTION", "OBJECT_OWNER", "OBJECT_NAME", "OBJECT_TYPE", "REFERENCED_OWNER", "REFERENCED_NAME", "REFERENCED_TYPE", "DEPENDENCY_TYPE", "REFERENCED_LINK_NAME"],
    rows: [["DEPENDS_ON", owner, name, "TRIGGER", parentOwner, parentName, "VIEW", "HARD", null]],
  });
  const host = await mountTriggerBrowser("triggers", connection);
  [...host.querySelectorAll<HTMLElement>("[title]")]
    .find((item) => item.title === name)!
    .closest(".grid")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  await vi.waitFor(() => expect(host.querySelector("[data-object-source-editor] .cm-editor")).not.toBeNull(), { timeout: 30_000 });
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>("[data-object-source-editor] .cm-editor")!)!;
  const original = view.state.doc.toString();
  view.dispatch({ changes: { from: 0, insert: "-- keep browser draft\n" }, selection: { anchor: 2, head: 5 } });
  await nextTick();
  const draft = view.state.doc.toString();
  const section = () => host.querySelector<HTMLButtonElement>('[data-object-section="dependencies"]');
  expect(section()).not.toBeNull();
  section()!.click();
  const dependency = () => [...host.querySelectorAll<HTMLButtonElement>("[data-object-details] table button")].find((item) => item.textContent?.trim() === parentName.trim());
  await vi.waitFor(() => expect(dependency()).toBeDefined());
  expect(rpc.executeQuery).toHaveBeenCalledWith(config.id, "service", expect.stringContaining("d.TYPE = 'TRIGGER'"), owner, expect.stringContaining("object-dependencies-"), { catalog: " Catalog " });
  useQueryStore().createTab("other-connection", "other-database", "Other query");
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  dependency()!.click();
  expect(confirm).toHaveBeenCalledOnce();
  expect(openDependencyObject).not.toHaveBeenCalled();
  host.querySelector<HTMLButtonElement>('[data-object-section="source"]')!.click();
  await nextTick();
  expect(EditorView.findFromDOM(host.querySelector<HTMLElement>("[data-object-source-editor] .cm-editor")!)).toBe(view);
  expect(view.state.doc.toString()).toBe(draft);
  expect([view.state.selection.main.anchor, view.state.selection.main.head]).toEqual([2, 5]);
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(original);
  section()!.click();
  await nextTick();
  dependency()!.click();
  expect(openDependencyObject).toHaveBeenCalledWith(expect.objectContaining({ connectionId: config.id, database: "service", catalog: " Catalog ", schema: owner, name, objectType: "TRIGGER" }), { schema: parentOwner, name: parentName, type: "view", schemaQuoted: true, nameQuoted: true });
  expect(rpc.executeQuery.mock.calls.every((call) => call[2].includes("ALL_DEPENDENCIES"))).toBe(true);
});

it.each(["panel-toggle", "source-close", "same-row", "other-row"])("keeps the trigger editor and undo when cancelling %s, then leaves only after explicit discard", async (action) => {
  raw.source = `CREATE OR REPLACE TRIGGER ${quote(owner)}.${quote(name)} INSTEAD OF INSERT ON ${quote(parentOwner)}.${quote(parentName)} DISABLE BEGIN NULL; END;`;
  raw.trigger!.oracle_metadata!.definition = { origin: "DBMS_METADATA", format: "ddl", complete: true };
  raw.trigger!.oracle_metadata!.reads.definition = { state: "available" };
  const second = structuredClone(raw);
  second.name = second.trigger!.name = second.trigger!.oracle_metadata!.name = "OtherTrigger";
  second.trigger!.oracle_metadata!.objectId = "other-trigger-id";
  second.source = raw.source.replace(quote(name), quote(second.name));
  rpc.listObjects.mockResolvedValue([raw, second].map((item) => ({ name: item.name, schema: owner, object_type: "TRIGGER", trigger: item.trigger })));
  rpc.getObjectSource.mockImplementation(async (_id, _db, _owner, requestedName) => structuredClone(requestedName === second.name ? second : raw));
  rpc.prepareOracleTriggerSql.mockImplementation(async (input) => ({ definition: input.source, comparisonSource: input.source, header: { scope: "RELATION", owner: parentOwner, name: parentName, viewOnly: true, pluggable: false }, requiresStateRestore: false }));
  const host = await mountTriggerBrowser();
  const clickRow = (rowName: string) =>
    [...host.querySelectorAll<HTMLElement>("[title]")]
      .find((item) => item.title === rowName)!
      .closest(".grid")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  clickRow(name);
  await vi.waitFor(() => expect(host.querySelector("[data-object-source-editor] .cm-editor")).not.toBeNull(), { timeout: 30_000 });
  const editor = () => host.querySelector<HTMLElement>("[data-object-source-editor] .cm-editor");
  const view = EditorView.findFromDOM(editor()!)!;
  const original = view.state.doc.toString();
  view.dispatch({ changes: { from: 0, insert: "-- keep on cancelled navigation\n" }, selection: { anchor: 2, head: 5 } });
  await nextTick();
  const draft = view.state.doc.toString();
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  const leave = () => {
    if (action === "source-close") [...host.querySelector("[data-object-details]")!.previousElementSibling!.querySelectorAll<HTMLButtonElement>("button")].at(-1)!.click();
    else if (action === "panel-toggle") host.querySelector<HTMLButtonElement>(`button[title="${i18n.global.t("objects.closeDetailPanel")}"]`)!.click();
    else clickRow(action === "same-row" ? name : second.name);
  };
  const reads = rpc.getObjectSource.mock.calls.length;
  leave();
  await nextTick();
  expect(confirm).toHaveBeenCalledOnce();
  expect(editor()).not.toBeNull();
  expect(EditorView.findFromDOM(editor()!)).toBe(view);
  expect(view.state.doc.toString()).toBe(draft);
  expect([view.state.selection.main.anchor, view.state.selection.main.head]).toEqual([2, 5]);
  expect(rpc.getObjectSource).toHaveBeenCalledTimes(reads);
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(original);
  view.dispatch({ changes: { from: 0, insert: "-- explicit discard\n" } });
  await nextTick();
  confirm.mockReturnValue(true);
  leave();
  await vi.waitFor(() => expect(action === "other-row" ? host.textContent?.includes(second.name) && editor() !== view.dom : !editor()).toBe(true));
  if (action === "other-row") {
    await vi.waitFor(() => expect(editor()).not.toBeNull());
    expect(EditorView.findFromDOM(editor()!)!.state.doc.toString()).toContain(quote(second.name));
    expect(EditorView.findFromDOM(editor()!)!.state.doc.toString()).not.toContain("explicit discard");
  }
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(rpc.executeQuery).not.toHaveBeenCalled();
});

it("retains the latest browser draft and editor across an incomplete identity read and a successful retry", async () => {
  raw.source = `CREATE OR REPLACE TRIGGER ${quote(owner)}.${quote(name)} INSTEAD OF INSERT ON ${quote(parentOwner)}.${quote(parentName)} DISABLE BEGIN NULL; END;`;
  raw.trigger!.oracle_metadata!.definition = { origin: "DBMS_METADATA", format: "ddl", complete: true };
  raw.trigger!.oracle_metadata!.reads.definition = { state: "available" };
  rpc.prepareOracleTriggerSql.mockImplementation(async (input) => ({ definition: input.source, comparisonSource: input.source, header: { scope: "RELATION", owner: parentOwner, name: parentName, viewOnly: true, pluggable: false }, requiresStateRestore: false }));
  const host = await mountTriggerBrowser();
  [...host.querySelectorAll<HTMLElement>("[title]")]
    .find((item) => item.title === name)!
    .closest(".grid")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  const editor = () => host.querySelector<HTMLElement>("[data-object-source-editor] .cm-editor");
  await vi.waitFor(() => expect(editor()).not.toBeNull(), { timeout: 30_000 });
  const view = EditorView.findFromDOM(editor()!)!;
  view.dispatch({ changes: { from: 0, insert: "-- preserve incomplete refresh draft\n" } });
  await nextTick();
  const incomplete = structuredClone(raw);
  incomplete.trigger!.oracle_metadata!.reads.identity = { state: "incomplete", message: "identity changed while reading" };
  rpc.getObjectSource.mockResolvedValueOnce(incomplete);
  const refresh = () => host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.global.t("structureEditor.refresh")}"]`)!;
  refresh().click();
  await nextTick();
  await vi.waitFor(() => expect(refresh().disabled).toBe(false));
  await vi.waitFor(() => expect(host.textContent).toContain("identity is unavailable"));
  expect(editor()).not.toBeNull();
  expect(EditorView.findFromDOM(editor()!)).toBe(view);
  view.dispatch({ changes: { from: view.state.doc.length, insert: "\n-- latest correction" } });
  await nextTick();
  const latest = view.state.doc.toString();
  rpc.getObjectSource.mockResolvedValueOnce(structuredClone(raw));
  refresh().click();
  await nextTick();
  await vi.waitFor(() => expect(refresh().disabled).toBe(false));
  expect(EditorView.findFromDOM(editor()!)).toBe(view);
  expect(view.state.doc.toString()).toBe(latest);
  expect(undo(view)).toBe(true);
  expect(rpc.executeQuery).not.toHaveBeenCalled();
});

it("does not authorize saving the old browser draft from an unknown same-ID concurrent body readback", async () => {
  raw.source = `CREATE OR REPLACE TRIGGER ${quote(owner)}.${quote(name)} INSTEAD OF INSERT ON ${quote(parentOwner)}.${quote(parentName)} DISABLE BEGIN NULL; END;`;
  raw.trigger!.oracle_metadata!.definition = { origin: "DBMS_METADATA", format: "ddl", complete: true };
  raw.trigger!.oracle_metadata!.reads.definition = { state: "available" };
  const initial = raw.source;
  rpc.prepareOracleTriggerSql.mockImplementation(async (input) => ({ definition: input.source, comparisonSource: input.source, header: { scope: "RELATION", owner: parentOwner, name: parentName, viewOnly: true, pluggable: false }, requiresStateRestore: false }));
  const host = await mountTriggerBrowser();
  [...host.querySelectorAll<HTMLElement>("[title]")]
    .find((item) => item.title === name)!
    .closest(".grid")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  await vi.waitFor(() => expect(host.querySelector("[data-object-source-editor] .cm-editor")).not.toBeNull(), { timeout: 30_000 });
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>("[data-object-source-editor] .cm-editor")!)!;
  view.dispatch({ changes: { from: 0, insert: "-- keep my version\n" } });
  await nextTick();
  const draft = view.state.doc.toString();
  rpc.executeQuery.mockImplementation(async (_id, _db, sql) => {
    if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[parentOwner, parentName, "VIEW", "parent-id"]] };
    raw.source = initial.replace("NULL;", "other_session_proc;");
    return { columns: [], rows: [] };
  });
  [...host.querySelectorAll<HTMLButtonElement>("[data-oracle-trigger-status] button")].find((item) => item.textContent?.trim() === i18n.global.t("processList.oracleInvalidObjects.compile"))!.click();
  const danger = useSqlExecutionDangerStore();
  await vi.waitFor(() => expect(danger.pending).toBeDefined());
  danger.confirm();
  await vi.waitFor(() => expect(host.textContent).toContain(i18n.global.t("oracleTrigger.reloadBaseline")));
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === i18n.global.t("objects.saveSource"))!.click();
  await vi.waitFor(() => expect(!!danger.pending || host.textContent?.includes(i18n.global.t("objects.sourceIdentityChanged"))).toBe(true));
  const confirmed = !!danger.pending;
  danger.cancelAll();
  expect(confirmed).toBe(false);
  expect(view.state.doc.toString()).toBe(draft);
  expect(rpc.executeQuery).toHaveBeenCalledOnce();
});

it.each(["before", "after"])("keeps the source panel bound to its displayed physical trigger when replacement happens %s compile", async (when) => {
  const host = await mountTriggerBrowser();
  [...host.querySelectorAll<HTMLElement>("[title]")]
    .find((item) => item.title === name)!
    .closest(".grid")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  const compile = () => [...host.querySelectorAll<HTMLButtonElement>("[data-oracle-trigger-status] button")].find((item) => item.textContent?.trim() === i18n.global.t("processList.oracleInvalidObjects.compile"));
  await vi.waitFor(() => expect(compile()).toBeDefined());
  if (when === "before") raw.trigger!.oracle_metadata!.objectId = "replacement-id";
  else
    rpc.executeQuery.mockImplementation(async () => {
      raw.trigger!.oracle_metadata!.objectId = "replacement-id";
      return { columns: [], rows: [] };
    });
  compile()!.click();
  const danger = useSqlExecutionDangerStore();
  if (when === "after") {
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    danger.confirm();
    await vi.waitFor(() => expect(host.textContent).toContain(i18n.global.t("oracleTrigger.reloadBaseline")));
    compile()!.click();
  }
  await vi.waitFor(() => expect(!!danger.pending || host.textContent?.includes("displayed trigger was replaced")).toBe(true));
  const confirmed = !!danger.pending;
  danger.cancelAll();
  expect(confirmed).toBe(false);
  expect(host.textContent).toContain("displayed trigger was replaced");
  expect(rpc.executeQuery).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
});

it.each(["source", "error-position"])("opens exact INVALID diagnostics from the existing source panel and repairs through a bound source tab (%s)", async (entry) => {
  if (entry === "error-position") {
    raw.source = `TRIGGER ${quote(owner)}.${quote(name)} INSTEAD OF INSERT ON ${quote(parentOwner)}.${quote(parentName)}\nBEGIN\n  missing_proc;\nEND;`;
    raw.trigger!.oracle_metadata!.definition = { origin: "ALL_SOURCE", format: "declaration", complete: true };
    raw.trigger!.oracle_metadata!.reads.definition = { state: "available" };
    raw.trigger!.oracle_metadata!.errors = [{ sequence: 1, line: 3, position: 3, text: "Missing procedure" }];
    rpc.prepareOracleTriggerSql.mockImplementation(async (input) => ({
      definition: input.source.startsWith("TRIGGER") ? "CREATE OR REPLACE " + input.source : input.source,
      comparisonSource: input.source,
      header: { scope: "RELATION", owner: parentOwner, name: parentName, viewOnly: true, pluggable: false },
      requiresStateRestore: false,
    }));
  }
  const host = await mountTriggerBrowser();
  [...host.querySelectorAll<HTMLElement>("[title]")]
    .find((item) => item.title === name)!
    .closest(".grid")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  await vi.waitFor(() => expect(host.querySelector("[data-oracle-trigger-status]")).not.toBeNull());
  const diagnostics = [...host.querySelectorAll<HTMLButtonElement>("[data-oracle-trigger-status] button")].find((item) => item.textContent?.trim() === i18n.global.t("processList.oracleInvalidObjects.errorsTitle"));
  expect(diagnostics).toBeDefined();
  diagnostics!.click();
  const dialog = () => document.querySelector('[role="dialog"]');
  await vi.waitFor(() => expect(dialog()?.textContent).toContain("Missing procedure"));
  expect(dialog()?.textContent).toContain(owner);
  const openSource = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    entry === "source" ? item.textContent?.trim() === i18n.global.t("processList.oracleInvalidObjects.openSource") : item.getAttribute("aria-label") === i18n.global.t("editor.locateError", { line: 3, column: 3 }),
  );
  openSource!.click();
  await vi.waitFor(() => expect(useQueryStore().tabs.some((tab) => tab.objectSource?.name === name && tab.objectSource.schema === owner)).toBe(true));
  const tab = useQueryStore().tabs.find((item) => item.objectSource?.name === name)!;
  expect(useQueryStore().oracleTriggerSourceState(tab.id)?.baseline?.target).toMatchObject({ owner, name, catalog: " Catalog " });
  expect(tab.title).not.toContain("Repair -");
  if (entry === "error-position") await vi.waitFor(() => expect(tab.editorRevealRequest).toMatchObject({ line: 3, column: 3 }));
  expect(rpc.executeQuery).not.toHaveBeenCalled();
});

it.each([
  { action: "enable", recreated: false },
  { action: "disable", recreated: false },
  { action: "compile", recreated: false },
  { action: "enable", recreated: true },
] as const)("runs $action from the existing trigger context menu with exact identity (recreated=$recreated)", async ({ action, recreated }) => {
  raw.trigger!.enabled = action !== "enable";
  const host = await mountTriggerBrowser();
  const label = () => [...host.querySelectorAll<HTMLElement>("[title]")].find((item) => item.title === name);
  await vi.waitFor(() => expect(label()).toBeDefined());
  label()!
    .closest(".grid")!
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
  const text = i18n.global.t(action === "compile" ? "contextMenu.compileObject" : action === "enable" ? "contextMenu.enableTrigger" : "contextMenu.disableTrigger");
  const menuButtons = () => [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")];
  await vi.waitFor(() => expect(menuButtons().some((item) => item.textContent?.trim() === i18n.global.t("contextMenu.viewSource"))).toBe(true));
  const menuItem = () => menuButtons().find((item) => item.textContent?.trim() === text);
  await vi.waitFor(() => expect(menuItem()).toBeDefined());
  if (recreated)
    rpc.getObjectSource.mockImplementation(async () => {
      const replaced: ObjectSource = JSON.parse(JSON.stringify(raw));
      replaced.trigger!.oracle_metadata!.objectId = "replacement-id";
      return replaced;
    });
  menuItem()!.click();
  if (recreated) {
    await vi.waitFor(() => expect(document.body.textContent).toContain("was replaced"));
    expect(useSqlExecutionDangerStore().pending).toBeUndefined();
    expect(rpc.executeQuery).not.toHaveBeenCalled();
    return;
  }
  const danger = useSqlExecutionDangerStore();
  await vi.waitFor(() => expect(danger.pending).toBeDefined());
  const sql = `ALTER TRIGGER " Trigger.Owner "." Tr""ig " ${action.toUpperCase()}${action === "compile" ? "" : ";"}`;
  expect(danger.pending!.sql).toBe(sql);
  danger.confirm();
  await vi.waitFor(() => expect(rpc.executeQuery).toHaveBeenCalledWith(config.id, "service", sql, executionSchema, undefined, { catalog: " Catalog ", timeoutSecs: 60 }));
  await vi.waitFor(() => expect(rpc.getObjectSource.mock.calls.length).toBeGreaterThanOrEqual(3));
  expect(rpc.getObjectSource.mock.calls.every((call) => call[2] === owner && call[3] === name && call[7]?.catalog === " Catalog ")).toBe(true);
  expect(rpc.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT"))).toHaveLength(1);
  if (action === "compile") await vi.waitFor(() => expect(document.body.textContent).toContain("Missing procedure"));
});

it.each(["menu", "keyboard", "batch-success", "batch-mixed", "batch-unknown", "batch-unknown-reconcile", "batch-cancel"] as const)("drops exact triggers through %s without collapsing names or replaying uncertain writes", async (entry) => {
  const mixed = entry === "batch-mixed";
  const actualParentName = mixed ? "PARENT_TABLE" : parentName;
  const actualParentOwner = mixed ? "PARENT_OWNER" : parentOwner;
  if (mixed) {
    raw.trigger!.oracle_metadata!.scope = "TABLE";
    raw.trigger!.oracle_metadata!.parent!.objectType = "TABLE";
    raw.trigger!.oracle_metadata!.parent!.name = actualParentName;
    raw.trigger!.oracle_metadata!.parent!.owner = actualParentOwner;
  }
  const secondOwner = " Second.Owner ";
  const second: ObjectSource = JSON.parse(JSON.stringify(raw));
  second.schema = secondOwner;
  second.trigger!.oracle_metadata!.owner = secondOwner;
  second.trigger!.oracle_metadata!.objectId = "second-id";
  const batch = entry.startsWith("batch"),
    sources = new Map([[owner, raw], ...(batch ? [[secondOwner, second] as const] : [])]);
  const deleted = new Set<string>();
  let deletedParent = false,
    denyGlobal = entry.includes("unknown");
  const parentDrop = `DROP TABLE ${quote(actualParentOwner)}.${quote(actualParentName)};`;
  rpc.listObjects.mockImplementation(async () => [
    ...[...sources].filter(([triggerOwner]) => !deleted.has(triggerOwner)).map(([triggerOwner, value]) => ({ name, schema: triggerOwner, object_type: "TRIGGER", trigger: JSON.parse(JSON.stringify(value.trigger)) })),
    ...(mixed && !deletedParent ? [{ name: actualParentName, schema: actualParentOwner, object_type: "TABLE" }] : []),
  ]);
  rpc.getObjectSource.mockImplementation(async (_id, _db, requestedOwner) => {
    const response: ObjectSource = JSON.parse(JSON.stringify(sources.get(requestedOwner)!));
    if (deleted.has(requestedOwner)) {
      response.source = "";
      Object.assign(response.trigger!.oracle_metadata!, { objectId: null, scope: "UNKNOWN", parent: null, errors: null });
      response.trigger!.oracle_metadata!.reads.identity = { state: "empty" };
    }
    return response;
  });
  rpc.executeQuery.mockImplementation(async (_id, _db, sql: string) => {
    if (sql.startsWith("SELECT USER")) return { columns: ["USER"], rows: [[executionSchema]] };
    if (sql.includes("FROM DBA_OBJECTS")) {
      if (denyGlobal) throw new Error("global dictionary denied after DROP");
      return { columns: ["OWNER", "OBJECT_NAME"], rows: [] };
    }
    if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: deletedParent ? [] : [[actualParentOwner, actualParentName, mixed ? "TABLE" : "VIEW", "parent-id"]] };
    if (mixed && sql === parentDrop) {
      deletedParent = true;
      return { columns: [], rows: [], affected_rows: 0 };
    }
    const triggerOwner = [...sources.keys()].find((value) => sql === dropSql(value));
    if (!triggerOwner) throw new Error(`Unexpected fixture write: ${sql}`);
    deleted.add(triggerOwner);
    return { columns: [], rows: [], affected_rows: 0 };
  });
  const host = await mountTriggerBrowser(mixed ? "all" : "triggers");
  const rowLabels = () => [...host.querySelectorAll<HTMLElement>("[title]")].filter((item) => item.title === name && item.closest<HTMLElement>(".vue-recycle-scroller__item-view")?.style.visibility !== "hidden");
  if (entry === "menu") {
    rowLabels()[0]
      .closest(".grid")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
    const drop = () => [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].find((button) => button.textContent?.trim() === i18n.global.t("contextMenu.dropTrigger"));
    await vi.waitFor(() => expect(drop()).toBeDefined());
    drop()!.click();
  } else {
    for (const label of rowLabels()) label.closest(".grid")!.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true, detail: 1 }));
    if (mixed)
      [...host.querySelectorAll<HTMLElement>("[title]")]
        .find((item) => item.title === actualParentName)!
        .closest(".grid")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true, detail: 1 }));
    await nextTick();
    if (entry === "keyboard") host.querySelector<HTMLElement>("[data-object-browser-root]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    else [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === i18n.global.t("objects.dropSelected"))!.click();
  }
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  await vi.waitFor(() => expect(dialog()!.textContent).toContain(dropSql(owner)));
  if (batch) expect(dialog()!.textContent).toContain(dropSql(secondOwner));
  const confirm = () => [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === i18n.global.t(batch ? "objects.dropSelected" : "dangerDialog.deleteConfirm"));
  await vi.waitFor(() => expect(confirm()?.disabled).toBe(false));
  if (entry === "batch-cancel") [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === i18n.global.t("common.cancel"))!.click();
  else confirm()!.click();
  const writes = () => rpc.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT")).map((call) => call[2]);
  if (entry === "batch-cancel") expect(writes()).toEqual([]);
  else if (entry.includes("unknown")) {
    await vi.waitFor(() => expect(document.body.textContent).toContain("global dictionary denied after DROP"));
    expect(writes()).toEqual([dropSql(owner)]);
    expect(rowLabels()).toHaveLength(2);
    if (entry === "batch-unknown-reconcile") {
      denyGlobal = false;
      const verify = [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].find((button) => button.textContent?.trim() === i18n.global.t("oracleTrigger.verifyReadOnly"));
      expect(verify).toBeDefined();
      await vi.waitFor(() => expect(verify!.disabled).toBe(false));
      const readCount = rpc.getObjectSource.mock.calls.length;
      verify!.click();
      await vi.waitFor(() => expect(rpc.getObjectSource.mock.calls.length).toBeGreaterThan(readCount));
      await vi.waitFor(() => expect(rowLabels(), document.body.textContent ?? "").toHaveLength(1));
      expect(writes()).toEqual([dropSql(owner)]);
    }
  } else {
    await vi.waitFor(() => expect(rowLabels()).toHaveLength(0));
    expect(writes()).toEqual(batch ? [dropSql(owner), dropSql(secondOwner), ...(mixed ? [parentDrop] : [])] : [dropSql(owner)]);
    expect(rpc.getObjectSource).toHaveBeenCalled();
  }
});
