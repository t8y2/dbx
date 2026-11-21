// @vitest-environment happy-dom
import { createApp, h, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { setLocale } from "@/i18n";
import OracleTableRenamePreview from "../OracleTableRenamePreview.vue";
import type { OracleTableRenamePlan } from "@/lib/table/oracleTableRename";

const plan: OracleTableRenamePlan = {
  target: { connectionId: "table-preview", database: "APP", databaseType: "oceanbase-oracle", schema: "APP", oldName: "T_OLD", newName: "T_NEW" },
  canonicalNewName: "T_NEW",
  tableObjectId: "1",
  dependents: [{ name: "P_READ", objectType: "PROCEDURE", objectId: "2", source: "ORIGINAL", executionSource: "ORIGINAL", status: "VALID", grants: "[]", errors: "[]", draft: "EDIT ME", rewrittenSource: "", fingerprint: "", originalFingerprint: "", rewriteRequired: true }],
  dependencyEdges: [],
  issues: [{ code: "source_rewrite_failed", message: "Dynamic SQL at line 3, column 5.", objectName: "P_READ", location: { line: 3, column: 5 }, repairable: true }],
  metadataComplete: true,
  executable: false,
  steps: [],
  statements: [],
};

const cleanups: Array<() => void> = [];
function mount() {
  const state = reactive({ plan, drafts: {} as Record<string, string>, loading: false, validating: false, executing: false });
  const edit = vi.fn();
  const validate = vi.fn();
  const reload = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp({ render: () => h(OracleTableRenamePreview, { ...state, onEdit: edit, onValidate: validate, onReload: reload }) }).use(i18n);
  app.mount(container);
  cleanups.push(() => {
    app.unmount();
    container.remove();
  });
  return { container, edit, validate, reload };
}

describe("Oracle table rename preview", () => {
  beforeEach(async () => {
    await setLocale("zh-CN");
  });
  afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

  it("shows the issue location and keeps the source editable for manual repair", () => {
    const { container } = mount();
    expect(container.textContent).toContain("P_READ");
    expect(container.textContent).toContain("第 3 行，第 5 列");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("EDIT ME");
    expect(container.querySelector("[data-validate]")).not.toBeNull();
  });

  it("emits draft edits and explicit revalidation", () => {
    const { container, edit, validate, reload } = mount();
    const editor = container.querySelector<HTMLTextAreaElement>("textarea")!;
    editor.value = "corrected source";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    expect(edit).toHaveBeenCalledWith("P_READ", "corrected source");
    container.querySelector<HTMLButtonElement>("[data-validate]")!.click();
    expect(validate).toHaveBeenCalledOnce();
    container.querySelector<HTMLButtonElement>("[data-reload]")!.click();
    expect(reload).toHaveBeenCalledOnce();
  });
});
