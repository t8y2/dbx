// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OracleUniqueEditor from "./OracleUniqueEditor.vue";
const mocks = vi.hoisted(() => ({ previewUniqueChange: vi.fn(), applyUniqueChange: vi.fn() }));
vi.mock("@/lib/backend/api", () => mocks);
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, values?: { column: string }) => values ? `${key}:${values.column}` : key }) }));
vi.mock("@/components/ui/button", async () => { const { defineComponent, h } = await import("vue"); return { Button: defineComponent({ inheritAttrs: false, setup: (_, { attrs, slots }) => () => h("button", attrs, slots.default?.()) }) }; });
let app: App;
let root: HTMLElement;
const confirm = vi.fn();
const changed = vi.fn();
const definition = { name: "UQ actual", columns: ["A"], enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false };
const snapshot = { ...definition, indexOwner: "Owner", indexName: "User Index" };
const plan = { revision: "reviewed", statements: ['ALTER TABLE "Owner"."T" DROP CONSTRAINT "UQ actual" KEEP INDEX', 'ALTER TABLE "Owner"."T" ADD CONSTRAINT "UQ actual" UNIQUE ("B", "A")'], currentConstraint: snapshot, affectedObjects: ["Preserve Owner.User Index"], recoveryStatements: ['ALTER TABLE "Owner"."T" ADD CONSTRAINT "UQ actual" UNIQUE ("A") USING INDEX "Owner"."User Index"'] };
async function settle() { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick(); }
function button(label: string) { const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label || button.getAttribute("aria-label") === label); expect(found, label).toBeDefined(); return found!; }
function mount(oceanbase = false) { root = document.createElement("div"); document.body.append(root); app = createApp(defineComponent({ setup: () => () => h(OracleUniqueEditor, { connectionId: "connection", database: "service", schema: "Owner", tableName: "T", columns: ["A", "B"], names: [definition.name], oceanbase, disabled: false, confirm, onChanged: changed }) })); app.mount(root); }
async function edit() { const select = root.querySelector("select")!; select.value = definition.name; select.dispatchEvent(new Event("change")); await settle(); button("uniqueEditor.edit").click(); await settle(); }
beforeEach(() => { vi.clearAllMocks(); confirm.mockResolvedValue(true); mocks.previewUniqueChange.mockResolvedValue(plan); });
afterEach(() => { app?.unmount(); root?.remove(); });
describe("UNIQUE constraint editing", () => {
  it("uses actual constraint identity, displays its index, and keeps column order", async () => {
    mount(); await edit(); expect(root.textContent).toContain("Owner.User Index");
    const column = root.querySelectorAll<HTMLInputElement>("[data-column]")[1]!; column.checked = true; column.dispatchEvent(new Event("change")); await settle(); button("constraintEditor.moveUp:B").click(); await settle(); button("constraintEditor.preview").click(); await settle();
    expect(mocks.previewUniqueChange).toHaveBeenLastCalledWith("connection", "service", { schema: "Owner", tableName: "T", originalName: definition.name, desired: { ...definition, columns: ["B", "A"] }, dropPreviousIndex: false });
    button("common.cancel").click(); await settle(); expect(mocks.applyUniqueChange).not.toHaveBeenCalled();
  });
  it("does not expose Oracle index or state options for OceanBase", async () => { mount(true); await edit(); expect(root.querySelector("[data-index-disposition]")).toBeNull(); expect(root.textContent).toContain("uniqueEditor.oceanbaseHint"); expect(root.textContent).not.toContain("foreignKeyEditor.enabled"); });
  it("shows partial failure and recovery instead of saving a successful draft", async () => {
    const failure = { success: false, steps: [{ sql: plan.statements[0], success: true, error: null }, { sql: plan.statements[1], success: false, error: "duplicate keys" }], currentConstraint: null, originalConstraint: null, refreshError: null, recoveryStatements: plan.recoveryStatements };
    mocks.applyUniqueChange.mockResolvedValue(failure); mount(); await edit(); button("constraintEditor.preview").click(); await settle(); button("constraintEditor.apply").click(); await settle();
    expect(root.textContent).toContain("constraintEditor.incomplete"); expect(root.textContent).toContain("duplicate keys"); expect(root.textContent).toContain(plan.recoveryStatements[0]); expect(button("constraintEditor.apply").disabled).toBe(true); expect(changed).toHaveBeenCalledWith(failure);
  });
  it("requests complete removal only after explicit selection and honors cancelled confirmation", async () => {
    mount(); await edit(); const drop = root.querySelector<HTMLInputElement>("[data-drop]")!; drop.checked = true; drop.dispatchEvent(new Event("change")); await settle(); button("constraintEditor.preview").click(); await settle();
    expect(mocks.previewUniqueChange).toHaveBeenLastCalledWith("connection", "service", { schema: "Owner", tableName: "T", originalName: definition.name, desired: null, dropPreviousIndex: false });
    confirm.mockResolvedValue(false); button("constraintEditor.apply").click(); await settle(); expect(mocks.applyUniqueChange).not.toHaveBeenCalled();
  });
});
