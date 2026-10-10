// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OracleCheckEditor from "./OracleCheckEditor.vue";
const mocks = vi.hoisted(() => ({ previewCheckChange: vi.fn(), applyCheckChange: vi.fn() }));
vi.mock("@/lib/backend/api", () => mocks);
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
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
const expression = '"Amount" >= 0\nAND "Label" <> q\'[a;);b]\'';
const key = { name: 'CK "Name"', expression, enabled: true, validated: false, deferrable: false, initiallyDeferred: false, rely: false };
const plan = { revision: "reviewed", statements: ['ALTER TABLE "T" DROP CONSTRAINT "CK"', `ALTER TABLE "T" ADD CONSTRAINT "CK" CHECK (\n${expression}\n)`], currentConstraint: key, affectedObjects: ["Owner.T"], recoveryStatements: [`ALTER TABLE "T" ADD CONSTRAINT "CK" CHECK (\n${expression}\n)`] };
async function settle() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}
function button(label: string) {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label);
  expect(found, label).toBeDefined();
  return found!;
}
function mount(oceanbase = false) {
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(defineComponent({ setup: () => () => h(OracleCheckEditor, { connectionId: "connection", database: "service", schema: "Owner", tableName: "T", names: [key.name], oceanbase, disabled: false, confirm, onChanged: changed }) }));
  app.mount(root);
}
async function edit() {
  const select = root.querySelector("select")!;
  select.value = key.name;
  select.dispatchEvent(new Event("change"));
  await settle();
  button("checkEditor.edit").click();
  await settle();
}
beforeEach(() => {
  vi.clearAllMocks();
  confirm.mockResolvedValue(true);
  mocks.previewCheckChange.mockResolvedValue(plan);
});
afterEach(() => {
  app?.unmount();
  root?.remove();
});
describe("CHECK editing", () => {
  it("preserves full multiline expressions and existing validation state in the draft", async () => {
    mount();
    await edit();
    expect(root.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(expression);
    expect(root.querySelector<HTMLInputElement>("[data-validated]")?.checked).toBe(false);
    button("constraintEditor.preview").click();
    await settle();
    expect(mocks.previewCheckChange).toHaveBeenLastCalledWith("connection", "service", { schema: "Owner", tableName: "T", originalName: key.name, desired: key });
    expect(root.querySelector("[data-preview-recovery]")?.textContent).toBe(plan.recoveryStatements.join(";\n"));
    expect(mocks.applyCheckChange).not.toHaveBeenCalled();
    button("common.cancel").click();
    await settle();
    expect(mocks.applyCheckChange).not.toHaveBeenCalled();
  });
  it("renders actual failed state and recovery without declaring success", async () => {
    const failure = { success: false, steps: [{ sql: plan.statements[1], success: false, error: "ORA-02293" }], currentConstraint: { ...key, enabled: false }, originalConstraint: { ...key, enabled: false }, refreshError: null, recoveryStatements: plan.recoveryStatements };
    mocks.applyCheckChange.mockResolvedValue(failure);
    mount();
    await edit();
    button("constraintEditor.preview").click();
    await settle();
    button("constraintEditor.apply").click();
    await settle();
    expect(root.textContent).toContain("constraintEditor.incomplete");
    expect(root.textContent).toContain("DISABLE NOVALIDATE");
    expect(root.textContent).toContain("ORA-02293");
    expect(root.textContent).toContain(expression);
    expect(button("constraintEditor.apply").disabled).toBe(true);
    expect(changed).toHaveBeenCalledWith(failure);
  });
  it("requires a fresh preview after expression changes and hides OceanBase deferred options", async () => {
    mount(true);
    await edit();
    button("constraintEditor.preview").click();
    await settle();
    const input = root.querySelector("textarea")!;
    input.value = "x > 3";
    input.dispatchEvent(new Event("input"));
    await settle();
    expect(button("constraintEditor.apply").disabled).toBe(true);
    expect(root.textContent).not.toContain("foreignKeyEditor.deferrable");
    expect(mocks.applyCheckChange).not.toHaveBeenCalled();
  });
  it("keeps validation errors visible and honors cancelled production confirmation", async () => {
    mount();
    await edit();
    mocks.previewCheckChange.mockRejectedValueOnce(new Error("Existing rows violate CHECK"));
    button("constraintEditor.preview").click();
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Existing rows violate CHECK");
    button("constraintEditor.preview").click();
    await settle();
    confirm.mockResolvedValue(false);
    button("constraintEditor.apply").click();
    await settle();
    expect(mocks.applyCheckChange).not.toHaveBeenCalled();
  });
});
