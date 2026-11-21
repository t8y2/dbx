// @vitest-environment happy-dom
import { createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { setLocale } from "@/i18n";
import OraclePackageSaveAsDialog from "../OraclePackageSaveAsDialog.vue";
import type { OraclePackageSaveAsPlan } from "@/lib/table/oraclePackageSaveAs";

const cleanups: Array<() => void> = [];
async function flush() {
  for (let turn = 0; turn < 5; turn += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
  }
}
function fixture(executable: boolean): OraclePackageSaveAsPlan {
  return {
    target: { connectionId: "c", database: "APP", databaseType: "oracle", schema: "APP", oldName: "P_OLD", newName: "P_NEW" },
    canonicalNewName: "P_NEW",
    snapshot: null,
    specDraft: "PACKAGE P_OLD AS END P_OLD;",
    bodyDraft: null,
    specSource: 'CREATE PACKAGE "P_NEW" AS END "P_NEW";',
    bodySource: null,
    statements: ['CREATE PACKAGE "P_NEW" AS END "P_NEW";'],
    issues: executable ? [] : [{ code: "source_rewrite_failed", message: "An uncertain member reference.", objectName: "PACKAGE", repairable: true }],
    metadataComplete: true,
    executable,
  };
}

function mount(plan: OraclePackageSaveAsPlan, drafts: { spec?: string; body?: string } = { spec: plan.specDraft, ...(plan.bodyDraft === null ? {} : { body: plan.bodyDraft }) }) {
  const confirm = vi.fn();
  const updateName = vi.fn();
  const updateOpen = vi.fn();
  const edit = vi.fn();
  const validate = vi.fn();
  const reload = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp({
    render: () =>
      h(OraclePackageSaveAsDialog, {
        open: true,
        oldName: "P_OLD",
        newName: "P_NEW",
        plan,
        drafts,
        error: "",
        diagnostic: "",
        loading: false,
        validating: false,
        executing: false,
        onConfirm: confirm,
        "onUpdate:newName": updateName,
        "onUpdate:open": updateOpen,
        onEdit: edit,
        onValidate: validate,
        onReload: reload,
      }),
  }).use(i18n);
  app.mount(container);
  cleanups.push(() => {
    app.unmount();
    container.remove();
  });
  return { container: document.body, confirm, updateName, updateOpen, edit, validate, reload };
}

describe("Oracle package Save As dialog", () => {
  beforeEach(async () => {
    await setLocale("zh-CN");
  });
  afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

  it("keeps confirmation disabled when a source issue needs resolution and localizes the prompt", async () => {
    const { container } = mount(fixture(false));
    await flush();
    expect(container.textContent).toContain(i18n.global.t("objects.packageSaveAsTitle"));
    expect(container.textContent).toContain(i18n.global.t("objects.packageSaveAsHint", { name: "P_OLD" }));
    expect(container.textContent).toContain(i18n.global.t("objects.viewRenameNeedsRepair"));
    expect(container.querySelector<HTMLButtonElement>("button[data-confirm]")?.disabled).toBe(true);
    expect(container.querySelector<HTMLDetailsElement>("li details")?.open).toBe(false);
  });

  it("shows the validated CREATE preview and emits the save action", async () => {
    const { container, confirm } = mount(fixture(true));
    await flush();
    expect(container.textContent).toContain('CREATE PACKAGE "P_NEW"');
    container.querySelector<HTMLButtonElement>("button[data-confirm]")?.click();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("keeps a package source draft editable and exposes revalidation", async () => {
    const original = "PACKAGE BODY P_OLD AS BEGIN NULL; END P_OLD;";
    const plan = { ...fixture(false), snapshot: { specSource: "PACKAGE P_OLD AS END P_OLD;", bodySource: original }, bodyDraft: original } as unknown as OraclePackageSaveAsPlan;
    const { container, edit, validate, reload } = mount(plan, { spec: plan.specDraft, body: original });
    await flush();
    const editor = container.querySelector<HTMLTextAreaElement>('[data-source-draft="body"]');
    expect(editor?.value).toBe(original);
    editor!.value = original.replace("P_OLD", "P_NEW");
    editor!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(edit).toHaveBeenCalledWith("body", expect.stringContaining("P_NEW"));
    container.querySelector<HTMLButtonElement>("[data-validate]")!.click();
    container.querySelector<HTMLButtonElement>("[data-reload]")!.click();
    expect(validate).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });
});
