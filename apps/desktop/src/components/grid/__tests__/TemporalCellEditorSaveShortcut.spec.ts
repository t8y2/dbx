// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp, defineComponent, h, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";

import TemporalCellEditor from "../TemporalCellEditor.vue";

const dataGridSource = readFileSync(resolve(import.meta.dirname, "../DataGrid.vue"), "utf8");
const cellDetailPanelSource = readFileSync(resolve(import.meta.dirname, "../DataGridCellDetailPanel.vue"), "utf8");

const dataGridTemporalEditors = dataGridSource.match(/<TemporalCellEditor\b[\s\S]*?\/>/g) ?? [];

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function mountEditor() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const modelValue = ref("2026-01-02 03:04:05");
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const onSave = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const Root = defineComponent({
    setup() {
      return () =>
        h(TemporalCellEditor, {
          kind: "datetime",
          modelValue: modelValue.value,
          "onUpdate:modelValue": (value: string) => {
            modelValue.value = value;
          },
          onCommit,
          onCancel,
          onSave,
        });
    },
  });
  const app = createApp(Root);
  app.use(pinia);
  app.mount(host);
  mountedApps.push({ app, host });
  const input = host.querySelector("input");
  if (!input) throw new Error("Temporal editor input not found");
  return { host, input, modelValue, onCommit, onCancel, onSave };
}

function keydown(target: HTMLInputElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("TemporalCellEditor save shortcut", () => {
  it("forwards Ctrl/Cmd+S to the grid instead of dropping it (#10515)", () => {
    const { input, onCommit, onCancel, onSave, modelValue } = mountEditor();

    input.value = "2026-03-04 05:06:07";
    input.dispatchEvent(new Event("input"));
    const event = keydown(input, { key: "s", ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(modelValue.value).toBe("2026-03-04 05:06:07");
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps the existing Enter commit and Escape cancel behaviour", () => {
    const enterCase = mountEditor();
    const enter = keydown(enterCase.input, { key: "Enter" });
    expect(enter.defaultPrevented).toBe(true);
    expect(enterCase.onCommit).toHaveBeenCalledOnce();
    expect(enterCase.onSave).not.toHaveBeenCalled();

    const escapeCase = mountEditor();
    const escape = keydown(escapeCase.input, { key: "Escape" });
    expect(escape.defaultPrevented).toBe(true);
    expect(escapeCase.onCancel).toHaveBeenCalledOnce();
    expect(escapeCase.onCommit).not.toHaveBeenCalled();
    expect(escapeCase.onSave).not.toHaveBeenCalled();
  });

  it("binds the forwarded save event on every grid temporal editor", () => {
    expect(dataGridTemporalEditors.length).toBeGreaterThan(0);
    for (const editor of dataGridTemporalEditors) {
      expect(editor).toContain('@save="onTemporalCellEditorSave"');
    }
    expect(cellDetailPanelSource).toContain("@save=\"emit('save')\"");
    expect(dataGridSource).toMatch(/onTemporalCellEditorSave\(\)[\s\S]*?saveGridChangesFromShortcut\(\)/);
  });
});
