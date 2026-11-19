// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import SchemaDiffDeployStep from "@/components/diff/SchemaDiffDeployStep.vue";
import { createOracleRoutineDeployment, editOraclePackageOptions, includeOraclePackageCompanion, reviewOraclePackageTargetDraft, selectOracleRoutineDraft, synchronizeOracleRoutineSelection } from "@/lib/schema/oracleRoutineDeploy";
import type { OracleRoutineOperation, OracleRoutineKind } from "@/types/schemaDiff";

const editor = vi.hoisted(() => ({ focus: vi.fn(), dispatch: vi.fn(), readOnly: vi.fn((_value: boolean) => []), dialect: vi.fn((_language: unknown, _dialect: string) => undefined), copy: vi.fn() }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: editor.copy }));

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

function routineFixture(kind: OracleRoutineKind = "FUNCTION") {
  const endpoint = { connectionId: "target", database: "tenant", schema: "Owner.With.Dot", databaseType: "oceanbase-oracle" as const, generation: 1 };
  const snapshot = { endpoint, state: "complete" as const, enumerationComplete: true, objects: [], issues: [] };
  const state = reactive(createOracleRoutineDeployment(snapshot, snapshot));
  const object = { id: "func-F", name: "F", routineType: kind, objectKind: "function" as const, operationType: "create" as const, selected: true };
  synchronizeOracleRoutineSelection(state, [object]);
  const identity = state.drafts[0].identity;
  const sql = kind === "FUNCTION" ? 'CREATE FUNCTION "Owner.With.Dot"."F" RETURN NUMBER AS BEGIN RETURN 1; END;' : `CREATE ${kind.replaceAll("_", " ")} "Owner.With.Dot"."F" AS END;`;
  state.drafts[0].sql = sql;
  state.plan = {
    target: endpoint,
    ready: false,
    steps: [{ identity, action: "create", sql, sourceOriginal: "raw source", targetOriginal: null, recoverySql: null, recoveryComplete: true, references: [], incomingCallers: [], operation: null, issues: [{ code: "unsupported", message: "Use a static reference", line: 1, column: 5 }] }],
  };
  return { state, object, sql, endpoint, identity };
}

describe("SchemaDiffDeployStep Oracle routine review", () => {
  it("reuses package editing and validation for transfer without offering a second execution or replacement of skipped kinds", async () => {
    const { state, object, sql, identity } = routineFixture("PACKAGE_BODY");
    const spec = { ...identity, kind: "PACKAGE" as const };
    const material = { version: { identity: spec, objectId: "spec", status: "VALID", lastDdlTime: "1" }, source: "complete specification", sourceComplete: true, dependencies: [], dependenciesComplete: true, issues: [] };
    state.source = { ...state.source, objects: [material] };
    state.target = { ...state.target, objects: [material] };
    const validate = vi.fn();
    const { container } = await mountDeployStep({ deploySql: sql, selectedObjects: [object], databaseType: "oracle", routineDeployment: state, packageTransfer: true, onValidateRoutines: validate });
    expect(container.textContent).not.toContain("diff.deployToServer");
    expect(container.textContent).not.toContain("diff.backToResult");
    expect(container.textContent).not.toContain("diff.packageAddSpecification");
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    buttons.find((button) => button.textContent?.trim() === "diff.routineValidate")!.click();
    expect(validate).toHaveBeenCalledOnce();
    expect(container.querySelector('input[type="radio"][value="target"]')).not.toBeNull();
    state.target = { ...state.target, objects: [] };
    await nextTick();
    expect(container.textContent).toContain("diff.packageAddSpecification");
  });

  it("offers an explicit manual target-draft review for cross-product packages without enabling deployment", async () => {
    const { state, object, sql } = routineFixture("PACKAGE");
    state.source = { ...state.source, endpoint: { ...state.source.endpoint, databaseType: "oracle" } };
    const { container } = await mountDeployStep({ deploySql: sql, selectedObjects: [object], databaseType: "oceanbase-oracle", routineDeployment: state, canExecute: false, onReviewPackageTarget: (id: string) => reviewOraclePackageTargetDraft(state, id) });
    expect(container.textContent).toContain("oracle → oceanbase-oracle");
    expect(container.textContent).toContain("diff.packageCrossProduct");
    const review = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("diff.packageReviewTarget"))!;
    expect(state.drafts[0].reviewedTargetDraft).not.toBe(true);
    review.click();
    await nextTick();
    expect(state.drafts[0].reviewedTargetDraft).toBe(true);
    expect(state.plan).toBeNull();
    const deploy = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("diff.deployToServer"))!;
    expect(deploy.disabled).toBe(true);
  });

  it("requires an explicit body choice, retains target body as a draft, and invalidates confirmation when its contract changes", async () => {
    const { state, object, sql, identity } = routineFixture("PACKAGE");
    const bodyIdentity = { ...identity, kind: "PACKAGE_BODY" as const };
    state.drafts[0].action = "replace";
    state.target = { ...state.target, objects: [{ version: { identity: bodyIdentity, objectId: "2", status: "VALID", lastDdlTime: "1" }, source: "complete target body", sourceComplete: true, dependencies: [], dependenciesComplete: true, issues: [] }] };
    const { container } = await mountDeployStep({
      deploySql: sql,
      selectedObjects: [object],
      databaseType: "oceanbase-oracle",
      routineDeployment: state,
      onIncludePackageCompanion: (id: string, source: "source" | "target") => includeOraclePackageCompanion(state, id, source),
      onUpdatePackageOptions: (id: string, options: Parameters<typeof editOraclePackageOptions>[2]) => editOraclePackageOptions(state, id, options),
    });
    expect(state.drafts).toHaveLength(1);
    const confirm = [...container.querySelectorAll<HTMLLabelElement>("label")].find((label) => label.textContent?.includes("diff.packageConfirmImpact"))!.querySelector<HTMLInputElement>("input")!;
    expect(confirm.checked).toBe(false);
    confirm.checked = true;
    confirm.dispatchEvent(new Event("change"));
    await nextTick();
    expect(state.drafts[0].confirmPackagePair).toBe(true);
    const retain = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("diff.packageRebuildTargetBody"))!;
    retain.click();
    await nextTick();
    expect(state.drafts).toHaveLength(2);
    expect(state.drafts[1]).toMatchObject({ identity: bodyIdentity, packageBodySource: "target", action: "replace" });
    expect(state.drafts[0].confirmPackagePair).toBe(false);
    expect(state.plan).toBeNull();
    const original = [...container.querySelectorAll("details")].find((detail) => detail.querySelector("summary")?.textContent === "diff.targetDdl")!;
    expect(original.querySelector("pre")?.textContent).toBe("complete target body");
    original.querySelector("button")!.click();
    expect(editor.copy).toHaveBeenCalledWith("complete target body");
    const targetContract = container.querySelector<HTMLInputElement>('input[type="radio"][value="target"]')!;
    targetContract.checked = true;
    targetContract.dispatchEvent(new Event("change"));
    await nextTick();
    expect(state.drafts[1].packageContract).toBe("target");
  });

  it("renders the Core package order and exposes recovery-only body source in the same review", async () => {
    const { state, object, sql, identity } = routineFixture("PACKAGE");
    const bodyIdentity = { ...identity, kind: "PACKAGE_BODY" as const };
    const specification = state.plan!.steps[0];
    const body = { ...specification, identity: bodyIdentity, action: "delete" as const, sql: 'DROP PACKAGE BODY "Owner.With.Dot"."F"', sourceOriginal: "complete original body" };
    state.recoveryPlan = { ...state.plan!, steps: [body, specification] };
    const { container } = await mountDeployStep({ deploySql: sql, selectedObjects: [object], databaseType: "oceanbase-oracle", routineDeployment: state, onSelectRoutine: (id: string) => selectOracleRoutineDraft(state, id) });
    const rows = [...container.querySelectorAll<HTMLElement>('[role="button"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("PACKAGE BODY");
    expect(rows[1].textContent).not.toContain("PACKAGE BODY");
    rows[0].click();
    await nextTick();
    expect(state.recoveryPlan).not.toBeNull();
    expect(state.drafts).toHaveLength(1);
    expect(container.textContent).toContain("Owner.With.Dot.F · PACKAGE_BODY");
    const source = [...container.querySelectorAll("details")].find((detail) => detail.querySelector("summary")?.textContent === "diff.sourceDdl")!;
    expect(source.querySelector("pre")?.textContent).toBe("complete original body");
    source.querySelector("button")!.click();
    expect(editor.copy).toHaveBeenCalledWith("complete original body");
  });

  it("shows specification success separately from an invalid body, preserves its full readback, and does not locate body errors in the specification editor", async () => {
    const { state, object, sql, endpoint, identity } = routineFixture("PACKAGE");
    const bodyIdentity = { ...identity, kind: "PACKAGE_BODY" as const };
    const body = 'CREATE OR REPLACE PACKAGE BODY "Owner.With.Dot"."F" AS -- 中文😀\nEND;';
    const record: OracleRoutineOperation = {
      operationId: "spec-success",
      target: endpoint,
      identity,
      lifecycle: "terminal",
      dispatched: true,
      acknowledged: true,
      error: null,
      readback: {
        identity,
        state: "verified",
        exists: true,
        version: null,
        source: sql,
        definitionMatches: true,
        issues: [],
        compilerMessages: [],
        packageCompanion: {
          identity: bodyIdentity,
          state: "invalid",
          exists: true,
          version: { identity: bodyIdentity, objectId: "12", status: "INVALID", lastDdlTime: "1" },
          source: body,
          definitionMatches: null,
          issues: [],
          compilerMessages: [
            { attribute: "ERROR", line: 3, position: 12, text: "PLS-00323" },
            { attribute: "WARNING", line: 4, position: 2, text: "unused package state" },
          ],
        },
      },
    };
    state.drafts[0].operation = record;
    state.plan!.steps[0].operation = record;
    state.plan!.steps[0].issues = [];
    const { container } = await mountDeployStep({ deploySql: sql, selectedObjects: [object], databaseType: "oceanbase-oracle", routineDeployment: state, canExecute: false });
    expect(container.textContent).toContain("diff.routineVerified");
    expect(container.textContent).toContain("PACKAGE BODY F · objects.invalid");
    expect(container.textContent).toContain("ERROR 3:12 — PLS-00323");
    expect(container.textContent).toContain("WARNING 4:2 — unused package state");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.includes("PLS-00323"))).toBe(false);
    const details = [...container.querySelectorAll("details")].find((detail) => detail.querySelector("summary")?.textContent === "diff.targetDdl · PACKAGE BODY")!;
    expect(details.querySelector("pre")?.textContent).toBe(body);
    details.querySelector("button")!.click();
    expect(editor.copy).toHaveBeenCalledWith(body);
    state.drafts[0].operation!.readback!.packageCompanion = { ...record.readback!.packageCompanion!, state: "missing", exists: false, version: null, source: null, compilerMessages: [] };
    await nextTick();
    expect(container.textContent).toContain("PACKAGE BODY F · objects.routineReadbackMissing");
  });

  it("does not present a VALID catalog status as complete companion verification when its source readback failed", async () => {
    const { state, object, sql, endpoint, identity } = routineFixture("PACKAGE");
    const companion = { ...identity, kind: "PACKAGE_BODY" as const };
    state.drafts[0].operation = {
      operationId: "pair-read-failed",
      target: endpoint,
      identity,
      lifecycle: "terminal",
      dispatched: true,
      acknowledged: true,
      error: null,
      readback: {
        identity,
        state: "readback-failed",
        exists: true,
        source: sql,
        version: null,
        definitionMatches: true,
        compilerMessages: [],
        issues: [],
        packageCompanion: {
          identity: companion,
          state: "readback-failed",
          exists: true,
          version: { identity: companion, objectId: "12", status: "VALID", lastDdlTime: "1" },
          source: null,
          definitionMatches: null,
          compilerMessages: [],
          issues: [{ stage: "source", code: "incomplete", message: "companion source incomplete" }],
        },
      },
    };
    const { container } = await mountDeployStep({ deploySql: sql, selectedObjects: [object], routineDeployment: state });
    expect(container.textContent).toContain("PACKAGE BODY F · diff.routineUnverified");
    expect(container.textContent).toContain("companion source incomplete");
    expect(container.textContent).not.toContain("PACKAGE BODY F · VALID");
  });

  it("locates a package-body compiler position after Unicode and an omitted stored owner in the body editor", async () => {
    const { state, object, endpoint, identity } = routineFixture("PACKAGE_BODY");
    const stored = "PACKAGE BODY \"F\" AS FUNCTION f RETURN NUMBER IS BEGIN RETURN '😀' + missing_identifier; END f; END;";
    const sql = `CREATE OR REPLACE ${stored.replace('"F"', '"Owner.With.Dot"."F"')}`;
    state.drafts[0].sql = sql;
    state.plan!.steps[0].sql = sql;
    state.plan!.steps[0].issues = [];
    state.drafts[0].operation = {
      operationId: "invalid-body",
      target: endpoint,
      identity,
      lifecycle: "terminal",
      dispatched: true,
      acknowledged: true,
      error: null,
      readback: {
        identity,
        state: "invalid",
        exists: true,
        source: `CREATE OR REPLACE ${stored}`,
        version: null,
        definitionMatches: true,
        issues: [],
        compilerMessages: [{ attribute: "ERROR", line: 1, position: Array.from(stored.slice(0, stored.indexOf("missing_identifier"))).length + 1, text: "package member missing" }],
      },
    };
    const { container } = await mountDeployStep({ deploySql: sql, selectedObjects: [object], routineDeployment: state, databaseType: "oceanbase-oracle" });
    const message = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("package member missing"))!;
    expect(message.disabled).toBe(false);
    message.click();
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor.dispatch).toHaveBeenCalledWith(expect.objectContaining({ selection: { anchor: sql.indexOf("missing_identifier") } }));
  });

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
