// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OraclePrimaryKeyEditor from "./OraclePrimaryKeyEditor.vue";

const mocks = vi.hoisted(() => ({ listConstraints: vi.fn(), previewPrimaryKeyChange: vi.fn(), applyPrimaryKeyChange: vi.fn() }));
vi.mock("@/lib/backend/api", () => mocks);
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, values?: { column: string }) => (values ? `${key}:${values.column}` : key) }) }));
vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      inheritAttrs: false,
      setup:
        (_, { attrs, slots }) =>
        () =>
          h("button", attrs, slots.default?.()),
    }),
  };
});

let app: App;
let root: HTMLElement;
const confirm = vi.fn();
const changed = vi.fn();
const plan = {
  statements: ['CREATE UNIQUE INDEX "support" ON "T" ("B", "A")', 'ALTER TABLE "T" DROP CONSTRAINT "PK" KEEP INDEX', 'ALTER TABLE "T" ADD CONSTRAINT "PK" PRIMARY KEY ("B", "A")'],
  revision: "reviewed",
  currentConstraint: null,
  affectedObjects: ["Preserve User Index"],
  recoveryStatements: ['ALTER TABLE "T" ADD CONSTRAINT "PK" PRIMARY KEY ("A") USING INDEX "User Index"'],
};

async function settle() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll("button")).find((item) => item.textContent === label || item.getAttribute("aria-label") === label);
  expect(found, label).toBeDefined();
  return found!;
}

function mount(disabled = false, oceanbase = false) {
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(
    defineComponent({
      setup: () => () =>
        h(OraclePrimaryKeyEditor, {
          connectionId: "oracle",
          database: "service",
          schema: "Owner",
          tableName: "T",
          columns: ["A", "B"],
          disabled,
          oceanbase,
          confirm,
          onChanged: changed,
        }),
    }),
  );
  app.mount(root);
}

async function editComposite() {
  button("constraintEditor.editPrimaryKey").click();
  await settle();
  const columns = root.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]');
  expect(columns[0]!.checked).toBe(true);
  columns[1]!.checked = true;
  columns[1]!.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  button("constraintEditor.moveUp:B").click();
  await settle();
  button("constraintEditor.preview").click();
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listConstraints.mockResolvedValue([{ name: "PK", constraint_type: "PRIMARY KEY", columns: ["A"] }]);
  mocks.previewPrimaryKeyChange.mockResolvedValue(plan);
  confirm.mockResolvedValue(true);
});
afterEach(() => {
  app?.unmount();
  root?.remove();
});

describe("Oracle primary-key editing", () => {
  it("uses OceanBase guidance and hides Oracle-only index removal while preserving the common preview flow", async () => {
    const oceanbasePlan = { ...plan, statements: ['ALTER TABLE "T" MODIFY PRIMARY KEY ("B", "A")'] };
    mocks.previewPrimaryKeyChange.mockResolvedValue(oceanbasePlan);
    mount(false, true);
    await editComposite();
    expect(root.querySelector("[data-index-disposition]")).toBeNull();
    expect(root.textContent).toContain("constraintEditor.oceanbasePrimaryKeyHint");
    expect(root.textContent).toContain(oceanbasePlan.statements[0]);
    expect(mocks.previewPrimaryKeyChange).toHaveBeenCalledWith("oracle", "service", { schema: "Owner", tableName: "T", columns: ["B", "A"], dropPreviousIndex: false });
    button("common.cancel").click();
    await settle();
    expect(mocks.applyPrimaryKeyChange).not.toHaveBeenCalled();
  });
  it("preserves selected column order, previews real backend DDL, and cancel executes nothing", async () => {
    mount();
    await editComposite();
    expect(mocks.previewPrimaryKeyChange).toHaveBeenCalledWith("oracle", "service", { schema: "Owner", tableName: "T", columns: ["B", "A"], dropPreviousIndex: false });
    expect(root.textContent).toContain("KEEP INDEX");
    expect(root.textContent).toContain("Preserve User Index");
    button("common.cancel").click();
    await settle();
    expect(mocks.applyPrimaryKeyChange).not.toHaveBeenCalled();
  });

  it("shows partial results and recovery without a success indication or blind retry", async () => {
    const partial = {
      success: false,
      steps: [
        { sql: plan.statements[1], success: true, error: null },
        { sql: plan.statements[2], success: false, error: "ORA-02437" },
      ],
      currentConstraint: null,
      refreshError: null,
      recoveryStatements: plan.recoveryStatements,
    };
    mocks.applyPrimaryKeyChange.mockResolvedValue(partial);
    mount();
    await editComposite();
    button("constraintEditor.apply").click();
    await settle();
    expect(confirm).toHaveBeenCalledWith(plan.statements.join(";\n"));
    expect(mocks.applyPrimaryKeyChange).toHaveBeenCalledWith("oracle", "service", { schema: "Owner", tableName: "T", columns: ["B", "A"], dropPreviousIndex: false }, "reviewed");
    expect(root.textContent).toContain("constraintEditor.incomplete");
    expect(root.textContent).toContain("ORA-02437");
    expect(root.textContent).toContain(plan.recoveryStatements[0]);
    expect(root.textContent).not.toContain("constraintEditor.applied");
    expect(button("constraintEditor.apply").disabled).toBe(true);
    expect(changed).toHaveBeenCalledWith(partial);
  });

  it("does not execute when production confirmation is cancelled", async () => {
    confirm.mockResolvedValue(false);
    mount();
    await editComposite();
    button("constraintEditor.apply").click();
    await settle();
    expect(mocks.applyPrimaryKeyChange).not.toHaveBeenCalled();
  });

  it("keeps metadata and preflight errors visible and blocks apply", async () => {
    mocks.previewPrimaryKeyChange.mockRejectedValue(new Error("Cannot confirm all referencing foreign keys"));
    mount();
    await editComposite();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Cannot confirm all referencing foreign keys");
    expect(button("constraintEditor.apply").disabled).toBe(true);
    expect(mocks.applyPrimaryKeyChange).not.toHaveBeenCalled();
  });

  it("does not start editing while the parent has a conflicting draft or read-only state", () => {
    mount(true);
    expect(button("constraintEditor.editPrimaryKey").disabled).toBe(true);
    button("constraintEditor.editPrimaryKey").click();
    expect(mocks.listConstraints).not.toHaveBeenCalled();
  });
});
