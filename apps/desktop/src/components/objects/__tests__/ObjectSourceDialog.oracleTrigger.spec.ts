// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSqlExecutionDangerStore } from "@/stores/sqlExecutionDangerStore";
import ObjectSourceDialog from "../ObjectSourceDialog.vue";
import type { ConnectionConfig, DatabaseType, ObjectSource } from "@/types/database";
import type { OracleTriggerSqlBinding } from "@/lib/database/oracleTriggerSql";

const owner = "Trigger.Owner",
  parent = "Parent.Owner",
  name = "Quoted Trigger";
const definition = `CREATE OR REPLACE TRIGGER "${owner}"."${name}" INSTEAD OF UPDATE ON "${parent}"."V" DISABLE BEGIN NULL; END;`;
const backend = vi.hoisted(() => ({
  getObjectSource: vi.fn(),
  executeQuery: vi.fn(),
  prepareOracleTriggerSql: vi.fn(),
  buildEditableObjectSource: vi.fn(async (input) => input.source),
  buildExecutableObjectSourceStatements: vi.fn(async (input) => [input.source]),
  checkConnectionHealth: vi.fn(async () => undefined),
  loadSchemaCache: vi.fn(async () => null),
  saveSchemaCache: vi.fn(async () => undefined),
  deleteSchemaCachePrefix: vi.fn(async () => undefined),
  listInstalledAgents: vi.fn(async () => []),
  listPlugins: vi.fn(async () => []),
  listCompletionObjects: vi.fn(async () => []),
  cancelQuery: vi.fn(async () => true),
}));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), ...backend }));
let raw: ObjectSource;
const cleanups: (() => void)[] = [];
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label);
}
function editor() {
  const root = document.querySelector<HTMLElement>("[data-object-source-editor] .cm-editor, [data-object-source-preview] .cm-editor");
  return root ? EditorView.findFromDOM(root) : null;
}
async function mount(initialEditing = true, createTrigger?: OracleTriggerSqlBinding, databaseType: DatabaseType = "oceanbase-oracle", exact = true) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connections = useConnectionStore();
  connections.connections = [{ id: "trigger-dialog", name: "Trigger test", db_type: databaseType, database: "service", username: "Execution.Owner" } as ConnectionConfig];
  connections.connectedIds.add("trigger-dialog");
  const state = reactive({ open: true, schema: owner, name });
  const saved = vi.fn();
  const opened = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(ObjectSourceDialog, {
        ...state,
        connectionId: "trigger-dialog",
        database: "service",
        executionSchema: "Execution.Owner",
        triggerIdentityMode: exact ? "exact" : undefined,
        objectType: "TRIGGER",
        databaseType,
        dialect: "mysql",
        initialEditing,
        createTrigger,
        onSaved: saved,
        onOpenObject: opened,
      }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  await vi.waitFor(() => expect(editor()).not.toBeNull(), { timeout: 30_000 });
  return { state, saved, opened, danger: useSqlExecutionDangerStore() };
}
beforeEach(() => {
  vi.clearAllMocks();
  raw = {
    name,
    schema: owner,
    object_type: "TRIGGER",
    source: definition,
    editable: false,
    trigger: {
      name,
      event: "UPDATE",
      timing: "INSTEAD OF",
      enabled: false,
      valid: true,
      oracle_metadata: {
        contractVersion: 1,
        identityMode: "exact",
        engine: "oceanbase-oracle",
        engineVersion: "4.2.5.7_107",
        owner,
        name,
        objectId: "9007199254740993",
        scope: "VIEW",
        parent: { owner: parent, name: "V", objectType: "VIEW" },
        definition: { origin: "DBMS_METADATA", format: "ddl", complete: true },
        errors: [],
        reads: { identity: { state: "available" }, scope: { state: "available" }, parent: { state: "available" }, enabled: { state: "available" }, validity: { state: "available" }, definition: { state: "available" }, errors: { state: "available" } },
      },
    },
  };
  backend.getObjectSource.mockImplementation(async () => JSON.parse(JSON.stringify(raw)));
  backend.prepareOracleTriggerSql.mockImplementation(async (input) => ({ definition: input.source, comparisonSource: input.source, header: { scope: "RELATION", owner: parent, name: "V", viewOnly: true, pluggable: false }, requiresStateRestore: false }));
  backend.executeQuery.mockImplementation(async (_id, _db, sql) => (sql.startsWith("SELECT") ? { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[parent, "V", "VIEW", "parent-id"]] } : { columns: [], rows: [], affected_rows: 0 }));
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("exact Oracle-family trigger in the existing source dialog", () => {
  it.each(["oracle", "dameng"] as const)("preserves the original editable %s dialog contract without opting into exact mode", async (databaseType) => {
    raw = { name, schema: owner, object_type: "TRIGGER", source: definition, editable: true };
    const { saved } = await mount(true, undefined, databaseType, false);
    expect(button("objects.saveSource")).toBeDefined();
    const candidate = definition.replace("NULL;", "legacy_correction;");
    const view = editor()!;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: candidate } });
    await nextTick();
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(backend.prepareOracleTriggerSql).not.toHaveBeenCalled();
    expect(backend.getObjectSource.mock.calls.every((call) => call[7] === undefined)).toBe(true);
    expect(backend.executeQuery).toHaveBeenCalledExactlyOnceWith("trigger-dialog", "service", candidate, owner);
  });

  it.each(["oracle", "dameng"] as const)("does not downgrade an explicitly exact %s request to the legacy writable path", async (databaseType) => {
    raw = { name, schema: owner, object_type: "TRIGGER", source: definition, editable: true };
    await mount(true, undefined, databaseType, true);
    expect(button("objects.saveSource")).toBeUndefined();
    expect(backend.getObjectSource.mock.calls[0][7]).toMatchObject({ identityMode: "exact" });
    expect(backend.buildEditableObjectSource).not.toHaveBeenCalled();
    expect(backend.buildExecutableObjectSourceStatements).not.toHaveBeenCalled();
    expect(backend.executeQuery).not.toHaveBeenCalled();
  });

  it("keeps a manually completed candidate through denied baseline recovery, then saves only after an authoritative reload", async () => {
    raw.source = "BEGIN NULL; END;";
    raw.trigger!.oracle_metadata!.definition = { origin: "catalog-body", format: "body", complete: false };
    raw.trigger!.oracle_metadata!.reads.definition = { state: "denied" };
    const { danger, saved } = await mount();
    const view = editor()!;
    const candidate = definition.replace("NULL;", "corrected_proc;");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: candidate } });
    await nextTick();
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(document.querySelector("[data-object-source-editor] .text-destructive")).not.toBeNull());
    expect(danger.pending).toBeUndefined();
    expect(backend.executeQuery).not.toHaveBeenCalled();
    raw.source = definition;
    raw.trigger!.oracle_metadata!.definition = { origin: "DBMS_METADATA", format: "ddl", complete: true };
    raw.trigger!.oracle_metadata!.reads.definition = { state: "available" };
    button("structureEditor.refresh")!.click();
    await nextTick();
    await vi.waitFor(() => expect(button("structureEditor.refresh")!.disabled).toBe(false));
    expect(editor()).toBe(view);
    expect(view.state.doc.toString()).toBe(candidate);
    backend.executeQuery.mockImplementation(async (_id, _db, sql) => {
      if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[parent, "V", "VIEW", "parent-id"]] };
      raw.source = sql;
      return { columns: [], rows: [] };
    });
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(danger.pending, document.body.textContent ?? "").toBeDefined());
    expect(danger.pending!.sql).toBe(candidate);
    danger.confirm();
    await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(raw.source).toBe(candidate);
    expect(backend.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT"))).toHaveLength(1);
  });

  it("never adopts a concurrent body from unknown compile readback as consent to save the old draft", async () => {
    const { danger, saved } = await mount();
    const view = editor()!;
    view.dispatch({ changes: { from: 0, insert: "-- my correction\n" } });
    await nextTick();
    const draft = view.state.doc.toString();
    backend.executeQuery.mockImplementation(async (_id, _db, sql) => {
      if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[parent, "V", "VIEW", "parent-id"]] };
      raw.source = definition.replace("NULL;", "other_session_proc;");
      return { columns: [], rows: [] };
    });
    button("processList.oracleInvalidObjects.compile")!.click();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    danger.confirm();
    await vi.waitFor(() => expect(document.body.textContent).toContain("oracleTrigger.reloadBaseline"));
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(!!danger.pending || !!document.querySelector("[data-object-source-editor] .text-destructive")).toBe(true));
    const confirmed = !!danger.pending;
    danger.cancelAll();
    expect(confirmed).toBe(false);
    expect(saved).not.toHaveBeenCalled();
    expect(editor()).toBe(view);
    expect(view.state.doc.toString()).toBe(draft);
    expect(backend.executeQuery).toHaveBeenCalledOnce();
  });

  it.each(["available", "denied", "missing-columns", "partial", "empty"])("uses the same dependency panel for an exact DM8 trigger and reports %s without losing its draft", async (result) => {
    raw.trigger!.oracle_metadata!.engine = "dm";
    raw.trigger!.oracle_metadata!.engineVersion = "8.1.3";
    const { opened } = await mount(true, undefined, "dameng");
    const view = editor()!;
    view.dispatch({ changes: { from: 0, insert: "-- keep this DM draft\n" } });
    await nextTick();
    const draft = view.state.doc.toString();
    backend.executeQuery.mockImplementation(async () => {
      if (result === "denied") throw new Error("DM dictionary denied");
      return {
        columns: result === "missing-columns" ? [] : ["DIRECTION", "OBJECT_OWNER", "OBJECT_NAME", "OBJECT_TYPE", "REFERENCED_OWNER", "REFERENCED_NAME", "REFERENCED_TYPE", "DEPENDENCY_TYPE", "REFERENCED_LINK_NAME"],
        rows:
          result === "empty" || result === "missing-columns"
            ? []
            : [
                ["DEPENDS_ON", owner, name, "TRIGGER", parent, "V", "VIEW", "HARD", null],
                ["REFERENCED_BY", "Caller", "UsesTrigger", "PROCEDURE", owner, name, "TRIGGER", "HARD", null],
                ["DEPENDS_ON", owner, name, "TRIGGER", "Remote", "V", "VIEW", "HARD", "REMOTE_DB"],
                ["DEPENDS_ON", owner, name, "TRIGGER", parent, "Unknown", "UNRECOGNIZED", "HARD", null],
              ],
        truncated: result === "partial",
      };
    });
    button("objectDependencies.dependencies")!.click();
    await vi.waitFor(() => expect(backend.executeQuery).toHaveBeenCalledOnce());
    const call = backend.executeQuery.mock.calls[0];
    expect(call[2]).toContain("d.TYPE = 'TRIGGER'");
    expect(call[2]).toContain(`d.OWNER = '${owner}'`);
    expect(call[3]).toBe(owner);
    expect(call[4]).toContain("object-dependencies-");
    expect(call[5]).toEqual({ catalog: undefined });
    if (result === "denied") await vi.waitFor(() => expect(document.body.textContent).toContain("DM dictionary denied"));
    else if (result === "missing-columns") await vi.waitFor(() => expect(document.body.textContent).toContain("unexpected column layout"));
    else if (result === "empty") await vi.waitFor(() => expect(document.body.textContent).toContain("objectDependencies.empty"));
    else {
      await vi.waitFor(() => expect(button("V")).toBeDefined());
      expect(document.body.textContent).toContain("objectDependencies.remoteObject");
      expect(document.body.textContent).toContain("objectDependencies.unsupportedObject");
      if (result === "partial") expect(document.body.textContent).toContain("objectDependencies.partial");
      button("objectDependencies.dependents")!.click();
      await nextTick();
      expect(button("UsesTrigger")).toBeDefined();
    }
    expect(opened).not.toHaveBeenCalled();
    button("objects.source")!.click();
    await nextTick();
    expect(editor()).toBe(view);
    expect(view.state.doc.toString()).toBe(draft);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(definition);
  });

  it.each(["TABLE", "VIEW"] as const)("opens the independent %s parent only after preserving the existing dirty-draft guard", async (kind) => {
    raw.trigger!.oracle_metadata!.scope = kind;
    raw.trigger!.oracle_metadata!.parent!.objectType = kind;
    const { opened } = await mount();
    const view = editor()!;
    view.dispatch({ changes: { from: 0, insert: "-- retain me\n" } });
    await nextTick();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    button(`${parent}.V · ${kind}`)!.click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(opened).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toContain("-- retain me");
    confirm.mockReturnValue(true);
    button(`${parent}.V · ${kind}`)!.click();
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ schema: owner, name, connectionId: "trigger-dialog" }), { schema: parent, name: "V", type: kind.toLowerCase(), schemaQuoted: true, nameQuoted: true });
    expect(backend.executeQuery).not.toHaveBeenCalled();
  });

  it("does not confirm native compilation of a same-name replacement", async () => {
    const { danger } = await mount();
    raw.trigger!.oracle_metadata!.objectId = "replacement-id";
    button("processList.oracleInvalidObjects.compile")!.click();
    await vi.waitFor(() => expect(!!danger.pending || document.body.textContent?.includes("displayed trigger was replaced")).toBe(true));
    const confirmed = !!danger.pending;
    danger.cancelAll();
    expect(confirmed).toBe(false);
    expect(editor()!.state.doc.toString()).toBe(definition);
    expect(backend.executeQuery).not.toHaveBeenCalled();
  });

  it("keeps the original baseline and draft when a post-compile read sees a new physical object", async () => {
    const { danger, saved } = await mount();
    const view = editor()!;
    view.dispatch({ changes: { from: 0, insert: "-- unsaved repair\n" } });
    await nextTick();
    const draft = view.state.doc.toString();
    backend.executeQuery.mockImplementation(async () => {
      raw.trigger!.oracle_metadata!.objectId = "replacement-id";
      return { columns: [], rows: [] };
    });
    button("processList.oracleInvalidObjects.compile")!.click();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    danger.confirm();
    await vi.waitFor(() => expect(document.body.textContent).toContain("oceanbasePrimaryKey.unknown"));
    expect(editor()).toBe(view);
    expect(view.state.doc.toString()).toBe(draft);
    expect(document.body.textContent).toContain("oracleTrigger.reloadBaseline");
    expect(saved).not.toHaveBeenCalled();
    button("processList.oracleInvalidObjects.compile")!.click();
    await vi.waitFor(() => expect(!!danger.pending || document.body.textContent?.includes("displayed trigger was replaced")).toBe(true));
    const confirmed = !!danger.pending;
    danger.cancelAll();
    expect(confirmed).toBe(false);
    expect(backend.executeQuery).toHaveBeenCalledOnce();
  });

  it.each([false, true])("locates dictionary errors only in unchanged stored text without replacing the dirty draft (changed=%s)", async (changed) => {
    const stored = `TRIGGER "${owner}"."${name}" INSTEAD OF UPDATE ON "${parent}"."V"\nBEGIN\n  missing_proc;\nEND;`;
    raw.source = stored;
    raw.trigger!.valid = false;
    raw.trigger!.oracle_metadata!.definition = { origin: "ALL_SOURCE", format: "declaration", complete: true };
    raw.trigger!.oracle_metadata!.errors = [{ sequence: 1, line: 3, position: 3, text: "Missing procedure" }];
    backend.prepareOracleTriggerSql.mockImplementation(async (input) => ({
      definition: input.source.startsWith("TRIGGER") ? "CREATE OR REPLACE " + input.source : input.source,
      comparisonSource: input.source,
      header: { scope: "RELATION", owner: parent, name: "V", viewOnly: true, pluggable: false },
      requiresStateRestore: false,
    }));
    await mount();
    const view = editor()!;
    const previous = view.state.doc.toString();
    view.dispatch({ changes: changed ? { from: previous.indexOf("missing_proc"), to: previous.indexOf("missing_proc") + "missing_proc".length, insert: "corrected_proc" } : { from: 0, insert: "-- keep this unsaved comment\n" } });
    const draft = view.state.doc.toString();
    const selection = view.state.selection.main.head;
    await nextTick();
    button("processList.oracleInvalidObjects.errorsTitle")!.click();
    const locate = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === "editor.locateError");
    await vi.waitFor(() => expect(locate()).toBeDefined(), { timeout: 10_000 });
    locate()!.click();
    await vi.waitFor(() => expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1));
    if (!changed) await vi.waitFor(() => expect(view.state.selection.main.head).toBe(draft.indexOf("missing_proc")));
    else expect(view.state.selection.main.head).toBe(selection);
    expect(editor()).toBe(view);
    expect(view.state.doc.toString()).toBe(draft);
    expect(backend.executeQuery).not.toHaveBeenCalled();
  });

  it("returns from exact INVALID diagnostics and compile to the same dirty editor with undo intact", async () => {
    raw.trigger!.valid = false;
    raw.trigger!.oracle_metadata!.errors = [{ sequence: 1, line: 2, position: 3, text: "Missing procedure" }];
    const { danger } = await mount();
    const view = editor()!;
    view.dispatch({ changes: { from: 0, insert: "-- my unsaved repair\n" } });
    const draft = view.state.doc.toString();
    await nextTick();
    button("processList.oracleInvalidObjects.errorsTitle")!.click();
    const diagnosticButton = (label: string) => [...([...document.querySelectorAll('[role="dialog"]')].find((dialog) => dialog.textContent?.includes("processList.oracleInvalidObjects.title"))?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((item) => item.textContent?.trim() === label);
    await vi.waitFor(() => expect(diagnosticButton("processList.oracleInvalidObjects.compile")).toBeDefined(), { timeout: 10_000 });
    diagnosticButton("processList.oracleInvalidObjects.compile")!.click();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    danger.confirm();
    await vi.waitFor(() => expect(document.body.textContent).toContain("processList.oracleInvalidObjects.compileStillInvalid"));
    expect(editor()).toBe(view);
    expect(view.state.doc.toString()).toBe(draft);
    button("processList.oracleInvalidObjects.openSource")!.click();
    await nextTick();
    expect(editor()).toBe(view);
    expect(view.state.doc.toString()).toBe(draft);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(definition);
    expect(backend.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT"))).toHaveLength(1);
  });

  it.each([
    { databaseType: "oracle", scope: "SCHEMA", bindingOwner: "Event.Scope", header: 'AFTER CREATE ON "Event.Scope".SCHEMA', proof: ["Event.Scope", "scope-id"] },
    { databaseType: "oracle", scope: "DATABASE", header: "AFTER CREATE ON DATABASE", proof: ["ORCL", "2", "PDB"] },
    { databaseType: "dameng", scope: "TIMER", header: "AFTER TIMER ON DATABASE\nFOR EACH 1 DAY FOR EACH 1 MINUTE", proof: ["DM", "2026-01-01 00:00:00"] },
  ] as const)("previews a real $databaseType $scope definition without inventing a parent table", async ({ databaseType, scope, header, proof, ...selection }) => {
    raw.source = "";
    raw.trigger!.oracle_metadata!.objectId = null;
    raw.trigger!.oracle_metadata!.engine = databaseType === "dameng" ? "dm" : "oracle";
    raw.trigger!.oracle_metadata!.engineVersion = databaseType === "dameng" ? "8.1.3" : "19.0.0";
    raw.trigger!.oracle_metadata!.reads.identity = { state: "empty" };
    backend.prepareOracleTriggerSql.mockImplementation(async (input) => ({ definition: input.source, comparisonSource: input.source, header: { scope, ...(scope === "SCHEMA" ? { owner: "Event.Scope" } : {}), viewOnly: false, pluggable: false }, requiresStateRestore: false }));
    backend.executeQuery.mockResolvedValue({ columns: [], rows: [proof] });
    const { danger } = await mount(true, { scope, ...("bindingOwner" in selection ? { owner: selection.bindingOwner } : {}) }, databaseType);
    button("contextMenu.generateSql")!.click();
    await vi.waitFor(() => expect(editor()!.state.doc.toString()).toBe(`CREATE TRIGGER "${owner}"."${name}"\n${header}\nBEGIN\n  NULL;\nEND;`));
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    expect(danger.pending!.sql).toContain(header);
    expect(backend.executeQuery.mock.calls.every((call) => call[2].startsWith("SELECT") && !call[2].includes("ALL_OBJECTS"))).toBe(true);
    danger.cancelAll();
    await nextTick();
    expect(editor()!.state.doc.toString()).toContain(header);
  });

  it("does not offer unverified OceanBase scope templates or overwrite edits typed while metadata loads", async () => {
    raw.source = "";
    raw.trigger!.oracle_metadata!.objectId = null;
    raw.trigger!.oracle_metadata!.reads.identity = { state: "empty" };
    let resolveRead!: (source: ObjectSource) => void;
    backend.getObjectSource.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    await mount(true, { scope: "TABLE", owner: parent, name: "T" });
    expect([...document.querySelectorAll<HTMLOptionElement>("[data-trigger-create-scope] option")].map((option) => option.value)).toEqual(["TABLE", "VIEW"]);
    button("contextMenu.generateSql")!.click();
    await vi.waitFor(() => expect(backend.getObjectSource).toHaveBeenCalledOnce());
    editor()!.dispatch({ changes: { from: 0, insert: "-- preserve my manual definition" } });
    await nextTick();
    resolveRead(JSON.parse(JSON.stringify(raw)));
    await vi.waitFor(() => expect(button("contextMenu.generateSql")!.disabled).toBe(false));
    expect(editor()!.state.doc.toString()).toBe("-- preserve my manual definition");
    expect(backend.executeQuery).not.toHaveBeenCalled();
  });

  it.each(["TABLE", "VIEW"] as const)("creates the first $scope trigger, then corrects INVALID through replacement instead of replaying CREATE", async (scope) => {
    const parentName = scope === "VIEW" ? "V" : "T";
    const created = `CREATE TRIGGER "${owner}"."${name}"\n${scope === "VIEW" ? "INSTEAD OF" : "BEFORE"} INSERT ON "${parent}"."${parentName}"\nFOR EACH ROW\nBEGIN\n  NULL;\nEND;`;
    raw.source = "";
    raw.trigger!.oracle_metadata!.objectId = null;
    raw.trigger!.oracle_metadata!.reads.identity = { state: "empty" };
    raw.trigger!.oracle_metadata!.definition!.complete = false;
    raw.trigger!.oracle_metadata!.scope = scope;
    raw.trigger!.oracle_metadata!.parent = { owner: parent, name: parentName, objectType: scope };
    const canonical = (source: string) => source.replace(/^CREATE(?: OR REPLACE)? TRIGGER/, "CREATE OR REPLACE TRIGGER");
    backend.prepareOracleTriggerSql.mockImplementation(async (input) => ({
      definition: input.purpose === "replace" ? canonical(input.source) : input.source,
      comparisonSource: canonical(input.source),
      header: { scope: "RELATION", owner: parent, name: parentName, viewOnly: scope === "VIEW", pluggable: false },
      requiresStateRestore: false,
    }));
    let writes = 0;
    backend.executeQuery.mockImplementation(async (_id, _db, sql) => {
      if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[parent, parentName, scope, "parent-id"]] };
      writes++;
      raw.source = sql;
      raw.trigger!.enabled = true;
      raw.trigger!.valid = writes > 1;
      raw.trigger!.oracle_metadata!.objectId = "created-id";
      raw.trigger!.oracle_metadata!.reads.identity = { state: "available" };
      raw.trigger!.oracle_metadata!.definition!.complete = true;
      raw.trigger!.oracle_metadata!.errors = writes === 1 ? [{ line: 4, position: 3, text: "Fix this definition" }] : [];
      return { columns: [], rows: [], affected_rows: 0 };
    });
    const { danger, saved } = await mount(true, { scope, owner: parent, name: parentName });
    expect(backend.getObjectSource).not.toHaveBeenCalled(); // Opening creation is read-only and does not invent an existing source.
    button("contextMenu.generateSql")!.click();
    await vi.waitFor(() => expect(editor()!.state.doc.toString()).toBe(created));
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    expect(danger.pending!.sql).toBe(created);
    expect(danger.pending!.targetLabel).toContain(`${parent}.${parentName}`);
    expect(danger.pending!.targets).toBeUndefined();
    danger.confirm();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Fix this definition"));
    expect(editor()!.state.doc.toString()).toBe(created);
    expect(saved).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>("[data-trigger-create-name]")!.disabled).toBe(true);
    expect(backend.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT"))).toHaveLength(1);
    const view = editor()!;
    view.dispatch({ changes: { from: view.state.doc.toString().indexOf("NULL;"), to: view.state.doc.toString().indexOf("NULL;") + 5, insert: "NULL; -- corrected\n" } });
    await nextTick();
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    expect(danger.pending!.sql).toMatch(/^CREATE OR REPLACE TRIGGER/);
    danger.confirm();
    await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(backend.prepareOracleTriggerSql.mock.calls.filter(([input]) => input.purpose === "create")).toHaveLength(1);
    expect(backend.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT"))).toHaveLength(2);
  });

  it("shows a full disabled draft and previews the exact SQL before the existing guard and verified save", async () => {
    const { saved, danger } = await mount();
    expect(editor()!.state.doc.toString()).toBe(definition);
    expect(document.querySelector("[data-oracle-trigger-status]")?.textContent).toContain(`${parent}.V`);
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    expect(danger.pending?.sql).toBe(definition);
    expect(danger.pending?.targetLabel).toContain("Execution.Owner");
    expect(danger.pending?.targets).toBeUndefined();
    expect(backend.executeQuery.mock.calls.every((call) => call[2].startsWith("SELECT"))).toBe(true);
    danger.confirm();
    await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(backend.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT"))).toEqual([["trigger-dialog", "service", definition, "Execution.Owner", undefined, { catalog: undefined, timeoutSecs: 60 }]]);
  });

  it("preserves the actual CodeMirror draft after an unknown save and read-only refresh", async () => {
    const { saved, danger } = await mount();
    const view = editor()!;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n-- keep my correction" } });
    await nextTick();
    const draft = view.state.doc.toString();
    backend.executeQuery.mockImplementation(async (_id, _db, sql) => {
      if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[parent, "V", "VIEW", "parent-id"]] };
      throw new Error("response lost");
    });
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    danger.confirm();
    await vi.waitFor(() => expect(document.body.textContent).toContain("response lost"));
    expect(editor()!.state.doc.toString()).toBe(draft);
    expect(saved).not.toHaveBeenCalled();
    button("structureEditor.refresh")!.click();
    await nextTick();
    await vi.waitFor(() => expect(!!editor() && !button("structureEditor.refresh")!.disabled).toBe(true));
    expect(editor()!.state.doc.toString()).toBe(draft);
    expect(editor()).toBe(view);
    expect(backend.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT"))).toHaveLength(1);
  });

  it("cancels the queued SQL confirmation when this dialog changes target, sending no DDL", async () => {
    const { state, danger, saved } = await mount();
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    state.open = false;
    await nextTick();
    await vi.waitFor(() => expect(danger.pending).toBeUndefined());
    expect(backend.executeQuery.mock.calls.every((call) => call[2].startsWith("SELECT"))).toBe(true);
    expect(saved).not.toHaveBeenCalled();
  });
});
