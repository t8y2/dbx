// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileTemplate } from "vue/compiler-sfc";
import { AlertTriangle, Check, Loader2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const owners = [
  { name: "user authorization", path: "admin/DatabaseUserAdmin.vue", marker: '<Dialog v-model:open="sqlDialogOpen">', previewHeight: "50vh" },
  { name: "database authorization", path: "sidebar/SidebarTreeItemDialogs.vue", marker: '<Dialog :open="showCreateDatabasePreviewDialog"', previewHeight: "48vh" },
];
const mountedApps: Vue.App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe.each(owners)("$name SQL preview layout", (owner) => {
  async function mountDialog() {
    const filename = resolve(import.meta.dirname, "../../apps/desktop/src/components", owner.path);
    const source = readFileSync(filename, "utf8");
    const start = source.indexOf(owner.marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const template = source.slice(start, source.indexOf("</Dialog>", start) + "</Dialog>".length);
    const compiled = compileTemplate({ source: template, filename, id: owner.name, compilerOptions: { mode: "function" } });
    expect(compiled.errors).toEqual([]);
    const results: { step: { id: string }; status: string; message?: string }[] = [];
    const state = Vue.reactive({
      sqlDialogOpen: true,
      showCreateDatabasePreviewDialog: true,
      pendingResults: results,
      createDatabaseAuthorizationResults: results,
      pendingStatus: "partial",
      pendingDanger: true,
      applying: false,
      createDatabaseAuthorizationApplying: false,
      highlightedPendingSql: "SELECT 1;\n".repeat(100),
      createDatabasePreviewSql: "SELECT 1;\n".repeat(100),
      highlight: (value: string) => value,
      t: (key: string) => key,
      authorizationStepLabel: (result: (typeof results)[number]) => result.step.id,
      createDatabaseAuthorizationStepLabel: (result: (typeof results)[number]) => result.step.id,
      applyPendingSql: vi.fn(),
      applyCreateDatabaseAuthorizationPlan: vi.fn(),
      closeCreateDatabaseResult: vi.fn(),
      updateCreateDatabasePreviewDialog: vi.fn(),
    });
    const app = Vue.createApp({
      components: { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Button, AlertTriangle, Check, Loader2 },
      setup: () => state,
      render: new Function("Vue", compiled.code)(Vue),
    });
    mountedApps.push(app);
    app.mount(document.body.appendChild(document.createElement("div")));
    await Vue.nextTick();
    const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    expect(dialog).not.toBeNull();
    return { state, dialog };
  }

  it("caps the preferred content height to the remaining grid track before and after execution", async () => {
    const { state, dialog } = await mountDialog();
    expect(dialog.classList.contains("max-h-[calc(var(--dbx-viewport-height)-2rem)]")).toBe(true);
    expect(dialog.classList.contains("grid-rows-[auto_minmax(0,1fr)_auto]")).toBe(true);
    const sql = dialog.querySelector("pre")!;
    const middle = sql.parentElement!;
    expect(middle.classList.contains("grid-rows-[minmax(0,1fr)]")).toBe(true);
    expect(middle.classList.contains(`h-[${owner.previewHeight}]`)).toBe(true);
    expect(middle.classList.contains("max-h-full")).toBe(true);
    state.pendingResults.push({ step: { id: "created" }, status: "success" }, { step: { id: "grant" }, status: "failed", message: "permission denied".repeat(100) }, { step: { id: "skipped" }, status: "skipped" });
    await Vue.nextTick();
    expect(middle.classList.contains("h-[70vh]")).toBe(true);
    expect(middle.classList.contains("grid-rows-[minmax(0,1fr)_minmax(0,1fr)]")).toBe(true);
    expect(middle.classList.contains("max-h-full")).toBe(true);
    const resultPane = middle.children[1] as HTMLElement;
    for (const pane of [sql, resultPane]) {
      expect(pane.classList.contains("min-h-0")).toBe(true);
      expect(pane.classList.contains("min-w-0")).toBe(true);
      expect(pane.classList.contains("overscroll-contain")).toBe(true);
    }
    expect(sql.classList.contains("overflow-auto")).toBe(true);
    expect(resultPane.classList.contains("overflow-y-auto")).toBe(true);
    expect(resultPane.textContent).toContain("permission denied");
    expect(resultPane.textContent).toContain(owner.name === "user authorization" ? "userAdmin.stepSkipped" : "contextMenu.createDatabaseStepSkipped");
    expect(dialog.querySelector('[data-slot="dialog-header"]')).not.toBeNull();
    expect(dialog.querySelector('[data-slot="dialog-footer"]')!.querySelectorAll("button")).toHaveLength(1);
    state.pendingResults.splice(0);
    await Vue.nextTick();
    expect(middle.classList.contains(`h-[${owner.previewHeight}]`)).toBe(true);
    expect(middle.children).toHaveLength(1);
  });

  it("preserves execution guards and the result close action", async () => {
    const { state, dialog } = await mountDialog();
    const footer = dialog.querySelector('[data-slot="dialog-footer"]')!;
    const apply = footer.querySelectorAll("button")[1];
    state.applying = true;
    state.createDatabaseAuthorizationApplying = true;
    await Vue.nextTick();
    expect(apply.disabled).toBe(true);
    apply.click();
    expect(state.applyPendingSql).not.toHaveBeenCalled();
    expect(state.applyCreateDatabaseAuthorizationPlan).not.toHaveBeenCalled();
    state.applying = false;
    state.createDatabaseAuthorizationApplying = false;
    await Vue.nextTick();
    apply.click();
    expect(owner.name === "user authorization" ? state.applyPendingSql : state.applyCreateDatabaseAuthorizationPlan).toHaveBeenCalledOnce();
    state.pendingResults.push({ step: { id: "failed" }, status: "failed", message: "execution failed" });
    await Vue.nextTick();
    footer.querySelector("button")!.click();
    if (owner.name === "user authorization") expect(state.sqlDialogOpen).toBe(false);
    else expect(state.closeCreateDatabaseResult).toHaveBeenCalledOnce();
  });
});
