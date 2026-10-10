// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OracleForeignKeyEditor from "./OracleForeignKeyEditor.vue";
import type { ForeignKeyDefinition } from "@/types/constraintChange";

const mocks = vi.hoisted(() => ({ previewForeignKeyChange: vi.fn(), applyForeignKeyChange: vi.fn() }));
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
const key: ForeignKeyDefinition = { name: "FK quoted", columns: ["A", "B"], referencedSchema: "Parent", referencedTable: "Target", referencedColumns: ["X", "Y"], deleteRule: "NO ACTION", enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false };
const plan = {
  revision: "reviewed",
  statements: ['ALTER TABLE "Owner"."T" DROP CONSTRAINT "FK quoted"', 'ALTER TABLE "Owner"."T" ADD CONSTRAINT "FK quoted" FOREIGN KEY ("B", "A") REFERENCES "Parent"."Target" ("Y", "X")'],
  currentConstraint: key,
  affectedObjects: ["Owner.T → Parent.Target"],
  recoveryStatements: ['ALTER TABLE "Owner"."T" ADD CONSTRAINT "FK quoted" FOREIGN KEY ("A", "B") REFERENCES "Parent"."Target" ("X", "Y")'],
};
async function settle() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}
function button(label: string) {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label || button.getAttribute("aria-label") === label);
  expect(found, label).toBeDefined();
  return found!;
}
function mount(oceanbase = false, disabled = false) {
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(defineComponent({ setup: () => () => h(OracleForeignKeyEditor, { connectionId: "connection", database: "service", schema: "Owner", tableName: "T", columns: ["A", "B"], names: ["FK quoted"], oceanbase, disabled, confirm, onChanged: changed }) }));
  app.mount(root);
}
async function edit() {
  const select = root.querySelector("select")!;
  select.value = "FK quoted";
  select.dispatchEvent(new Event("change"));
  await settle();
  button("foreignKeyEditor.edit").click();
  await settle();
}
beforeEach(() => {
  vi.clearAllMocks();
  confirm.mockResolvedValue(true);
  mocks.previewForeignKeyChange.mockResolvedValue(plan);
});
afterEach(() => {
  app?.unmount();
  root?.remove();
});

describe("Oracle and OceanBase foreign-key editing", () => {
  it("loads the actual definition and reorders both sides of composite column pairs", async () => {
    mount();
    await edit();
    expect(mocks.previewForeignKeyChange).toHaveBeenLastCalledWith("connection", "service", { schema: "Owner", tableName: "T", originalName: "FK quoted", desired: null });
    expect(root.textContent).not.toContain(plan.statements[0]);
    button("constraintEditor.moveUp:B").click();
    await settle();
    button("constraintEditor.preview").click();
    await settle();
    expect(mocks.previewForeignKeyChange).toHaveBeenLastCalledWith("connection", "service", { schema: "Owner", tableName: "T", originalName: "FK quoted", desired: { ...key, columns: ["B", "A"], referencedColumns: ["Y", "X"] } });
    expect(root.textContent).toContain("Owner.T → Parent.Target");
    button("common.cancel").click();
    await settle();
    expect(mocks.applyForeignKeyChange).not.toHaveBeenCalled();
  });
  it("reports partial failure and recovery without accepting the draft or allowing immediate retry", async () => {
    const failure = {
      success: false,
      steps: [
        { sql: plan.statements[0], success: true, error: null },
        { sql: plan.statements[1], success: false, error: "ORA-02298" },
      ],
      currentConstraint: null,
      originalConstraint: null,
      refreshError: null,
      recoveryStatements: plan.recoveryStatements,
    };
    mocks.applyForeignKeyChange.mockResolvedValue(failure);
    mount();
    await edit();
    button("constraintEditor.preview").click();
    await settle();
    button("constraintEditor.apply").click();
    await settle();
    expect(confirm).toHaveBeenCalledWith(plan.statements.join(";\n"));
    expect(changed).toHaveBeenCalledWith(failure);
    expect(root.textContent).toContain("constraintEditor.incomplete");
    expect(root.textContent).toContain("ORA-02298");
    expect(root.textContent).toContain(plan.recoveryStatements[0]);
    expect(button("constraintEditor.apply").disabled).toBe(true);
  });
  it("requires a new preview for deletion and honors cancelled production confirmation", async () => {
    mount();
    await edit();
    const drop = root.querySelector<HTMLInputElement>("[data-drop]")!;
    drop.checked = true;
    drop.dispatchEvent(new Event("change"));
    await settle();
    button("constraintEditor.preview").click();
    await settle();
    expect(mocks.previewForeignKeyChange).toHaveBeenLastCalledWith("connection", "service", { schema: "Owner", tableName: "T", originalName: "FK quoted", desired: null });
    confirm.mockResolvedValue(false);
    button("constraintEditor.apply").click();
    await settle();
    expect(mocks.applyForeignKeyChange).not.toHaveBeenCalled();
  });
  it("hides deferred options for OceanBase and leaves metadata failures visible", async () => {
    mount(true);
    await edit();
    expect(root.textContent).not.toContain("foreignKeyEditor.deferrable");
    mocks.previewForeignKeyChange.mockRejectedValue(new Error("REFERENCES privilege unavailable"));
    button("constraintEditor.preview").click();
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("REFERENCES privilege unavailable");
    expect(button("constraintEditor.apply").disabled).toBe(true);
  });
  it("prevents editing while the parent is read-only or has another draft", () => {
    mount(false, true);
    expect(button("foreignKeyEditor.add").disabled).toBe(true);
    button("foreignKeyEditor.add").click();
    expect(mocks.previewForeignKeyChange).not.toHaveBeenCalled();
  });
});
