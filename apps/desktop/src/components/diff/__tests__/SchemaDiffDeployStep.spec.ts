// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import SchemaDiffDeployStep from "@/components/diff/SchemaDiffDeployStep.vue";
import { createOracleRoutineDeployment, synchronizeOracleRoutineSelection } from "@/lib/schema/oracleRoutineDeploy";
import type { OracleRoutineOperation } from "@/types/schemaDiff";

const editor = vi.hoisted(() => ({ focus: vi.fn(), dispatch: vi.fn(), readOnly: vi.fn((_value: boolean) => []), dialect: vi.fn((_language: unknown, _dialect: string) => undefined) }));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n", () => ({ default: { global: { t: (key: string) => key } } }));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ editorSettings: { theme: "default", fontSize: 12, fontFamily: "monospace" } }),
}));

vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false } }) }));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/lib/editor/editorThemes", () => ({
  loadEditorTheme: async () => [],
  editorFontTheme: () => [],
}));

vi.mock("@/lib/editor/codemirrorSqlDialect", () => ({ createDbxCodeMirrorSqlDialect: editor.dialect }));

// The deploy script preview is a CodeMirror view; the option under test lives in
// the footer, so the editor is replaced with the smallest view that still accepts
// the component's document updates.
vi.mock("@codemirror/view", () => ({
  EditorView: class {
    static scrollIntoView = vi.fn(() => ({}));
    static updateListener = { of: () => [] };
    state: { doc: { toString: () => string; length: number } };
    constructor(config: { state: { doc: { toString: () => string; length: number } } }) {
      this.state = config.state;
    }
    dispatch = editor.dispatch;
    focus = editor.focus;
    destroy() {}
  },
}));

vi.mock("@codemirror/state", () => ({
  EditorState: {
    readOnly: { of: editor.readOnly },
    create: (config: { doc: string }) => ({ doc: { toString: () => config.doc, length: config.doc.length } }),
  },
  Compartment: class {
    of() {
      return [];
    }
    reconfigure() {
      return [];
    }
  },
}));

vi.mock("@codemirror/lang-sql", () => ({ sql: () => [] }));

vi.mock("codemirror", () => ({ basicSetup: [] }));

const mountedApps: App[] = [];

async function mountDeployStep(extraProps: Record<string, unknown> = {}, onIgnoreForeignKeyChecks?: (value: boolean) => void, onContinueOnError?: (value: boolean) => void) {
  const state = reactive({ ignoreForeignKeyChecks: false, continueOnError: false });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(SchemaDiffDeployStep, {
          deploySql: "ALTER TABLE users ADD COLUMN nickname varchar(64);",
          selectedObjects: [],
          targetConnectionId: "mysql-1",
          targetDatabase: "shop",
          targetSchema: "shop",
          executing: false,
          ...extraProps,
          ignoreForeignKeyChecks: state.ignoreForeignKeyChecks,
          continueOnError: state.continueOnError,
          "onUpdate:ignoreForeignKeyChecks": (value: boolean) => {
            state.ignoreForeignKeyChecks = value;
            onIgnoreForeignKeyChecks?.(value);
          },
          "onUpdate:continueOnError": (value: boolean) => {
            state.continueOnError = value;
            onContinueOnError?.(value);
          },
        }),
    }),
  );
  mountedApps.push(app);
  app.mount(container);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { container, state };
}

function foreignKeyCheckbox(container: HTMLElement): HTMLInputElement | null {
  const label = [...container.querySelectorAll<HTMLLabelElement>("label")].find((candidate) => candidate.textContent?.includes("diff.ignoreForeignKeyChecks"));
  return label?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
}

function continueOnErrorCheckbox(container: HTMLElement): HTMLInputElement | null {
  const label = [...container.querySelectorAll<HTMLLabelElement>("label")].find((candidate) => candidate.textContent?.includes("diff.continueOnError"));
  return label?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
}

describe("SchemaDiffDeployStep continue-on-error option", () => {
  it("is offered unchecked by default and reports both states to the dialog", async () => {
    const updates: boolean[] = [];
    const { container, state } = await mountDeployStep({}, undefined, (value) => updates.push(value));

    const checkbox = continueOnErrorCheckbox(container);
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(false);
    expect(checkbox?.closest("label")?.getAttribute("title")).toBe("diff.continueOnErrorHint");

    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event("change"));
    await nextTick();
    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event("change"));
    await nextTick();

    expect(updates).toEqual([true, false]);
    expect(state.continueOnError).toBe(false);
  });

  it("is disabled while the deploy is running", async () => {
    const { container } = await mountDeployStep({ executing: true });

    expect(continueOnErrorCheckbox(container)?.disabled).toBe(true);
  });
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function routineFixture() {
  const endpoint = { connectionId: "target", database: "tenant", schema: "Owner.With.Dot", databaseType: "oceanbase-oracle" as const, generation: 1 };
  const snapshot = { endpoint, state: "complete" as const, enumerationComplete: true, objects: [], issues: [] };
  const state = reactive(createOracleRoutineDeployment(snapshot, snapshot));
  const object = { id: "func-F", name: "F", routineType: "FUNCTION", objectKind: "function" as const, operationType: "create" as const, selected: true };
  synchronizeOracleRoutineSelection(state, [object]);
  const identity = state.drafts[0].identity;
  const sql = 'CREATE FUNCTION "Owner.With.Dot"."F" RETURN NUMBER AS BEGIN RETURN 1; END;';
  state.drafts[0].sql = sql;
  state.plan = {
    target: endpoint,
    ready: false,
    steps: [{ identity, action: "create", sql, sourceOriginal: "raw source", targetOriginal: null, recoverySql: null, recoveryComplete: true, references: [], incomingCallers: [], operation: null, issues: [{ code: "unsupported", message: "Use a static reference", line: 1, column: 5 }] }],
  };
  return { state, object, sql, endpoint, identity };
}

describe("SchemaDiffDeployStep Oracle routine review", () => {
  it("keeps the editable draft and positioned issues in the existing editor, with explicit revalidation", async () => {
    const { state, object, sql } = routineFixture();
    const validate = vi.fn();
    const update = vi.fn();
    const { container } = await mountDeployStep({ deploySql: sql, selectedObjects: [object], databaseType: "oceanbase-oracle", routineDeployment: state, canExecute: false, onValidateRoutines: validate, "onUpdate:deploySql": update });
    expect(editor.dialect.mock.calls[0]?.[1]).toBe("oracle");
    expect(continueOnErrorCheckbox(container)).toBeNull();
    const issue = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("1:5 — Use a static reference"));
    expect(issue).toBeDefined();
    issue!.click();
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor.dispatch).toHaveBeenCalledWith(expect.objectContaining({ selection: { anchor: 4 } }));
    expect(editor.focus).toHaveBeenCalled();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    buttons.find((button) => button.textContent?.trim() === "diff.routineValidate")!.click();
    expect(validate).toHaveBeenCalledTimes(1);
    expect(buttons.find((button) => button.textContent?.trim() === "diff.deployToServer")!.disabled).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

  it("displays ACK and compiler evidence without a success label, and only locks verified definitions", async () => {
    const { state, object, sql, endpoint, identity } = routineFixture();
    const record: OracleRoutineOperation = {
      operationId: "original-invalid",
      target: endpoint,
      identity,
      lifecycle: "terminal",
      dispatched: true,
      acknowledged: true,
      error: null,
      readback: { identity, state: "invalid", exists: true, version: null, source: sql, definitionMatches: true, issues: [], compilerMessages: [{ attribute: "ERROR", line: 1, position: 20, text: "invalid identifier" }] },
    };
    state.drafts[0].operation = record;
    state.plan!.steps[0].operation = record;
    const observe = vi.fn();
    const { container } = await mountDeployStep({ deploySql: sql, selectedObjects: [object], databaseType: "oracle", routineDeployment: state, onObserveRoutine: observe });
    expect(container.textContent).toContain("objects.routineWriteAcknowledged");
    expect(container.textContent).toContain("ERROR 1:20 — invalid identifier");
    expect(container.textContent).not.toContain("diff.routineVerified");
    expect(editor.readOnly).toHaveBeenLastCalledWith(false);
    [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "diff.routineObserve")!.click();
    expect(observe).toHaveBeenCalledWith("original-invalid");
    state.drafts[0].operation = { ...record, readback: { ...record.readback!, state: "verified", compilerMessages: [] } };
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor.readOnly).toHaveBeenLastCalledWith(true);
    expect(container.textContent).toContain("diff.routineReadOnlyCompleted");
  });

  it("maps a compiler position past an omitted stored owner to the same token in the target draft", async () => {
    const { state, object, sql, endpoint, identity } = routineFixture();
    const draftSql = sql.replace("RETURN 1;", "RETURN missing_identifier;");
    const storedUnit = 'FUNCTION "F" RETURN NUMBER AS BEGIN RETURN missing_identifier; END';
    const position = storedUnit.indexOf("missing_identifier") + 1;
    const record: OracleRoutineOperation = {
      operationId: "invalid-short-header",
      target: endpoint,
      identity,
      lifecycle: "terminal",
      dispatched: true,
      acknowledged: true,
      error: null,
      readback: { identity, state: "invalid", exists: true, version: null, source: `CREATE OR REPLACE ${storedUnit}`, definitionMatches: true, issues: [], compilerMessages: [{ attribute: "ERROR", line: 1, position, text: "unknown identifier" }] },
    };
    state.drafts[0].sql = draftSql;
    state.drafts[0].operation = record;
    state.plan!.steps[0].sql = draftSql;
    state.plan!.steps[0].operation = record;
    const { container } = await mountDeployStep({ deploySql: draftSql, selectedObjects: [object], databaseType: "oracle", routineDeployment: state });
    const message = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("unknown identifier"))!;
    expect(message.disabled).toBe(false);
    message.click();
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor.dispatch).toHaveBeenCalledWith(expect.objectContaining({ selection: { anchor: draftSql.indexOf("missing_identifier") } }));
  });
});

describe("SchemaDiffDeployStep foreign key check option", () => {
  it("offers the option next to the export button for a MySQL target and leaves it unchecked by default", async () => {
    const { container } = await mountDeployStep({ showIgnoreForeignKeyChecks: true });

    const checkbox = foreignKeyCheckbox(container);
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(false);
    expect(checkbox?.closest("label")?.textContent).toContain("diff.ignoreForeignKeyChecks");
    expect(container.textContent).toContain("diff.exportSql");
  });

  it("keeps the option out of the footer for targets whose engine has no FOREIGN_KEY_CHECKS", async () => {
    const { container } = await mountDeployStep({ showIgnoreForeignKeyChecks: false });

    expect(foreignKeyCheckbox(container)).toBeNull();
    expect(container.textContent).not.toContain("diff.ignoreForeignKeyChecks");
  });

  it("reports the ticked and unticked states to the dialog", async () => {
    const updates: boolean[] = [];
    const { container, state } = await mountDeployStep({ showIgnoreForeignKeyChecks: true }, (value) => updates.push(value));

    const checkbox = foreignKeyCheckbox(container)!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    await nextTick();
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));
    await nextTick();

    expect(updates).toEqual([true, false]);
    expect(state.ignoreForeignKeyChecks).toBe(false);
  });

  it("disables the option while a deploy is running", async () => {
    const { container } = await mountDeployStep({ showIgnoreForeignKeyChecks: true, executing: true });

    expect(foreignKeyCheckbox(container)?.disabled).toBe(true);
  });
});
