// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";

import TemporalCellEditor from "../TemporalCellEditor.vue";

const dataGridSource = readFileSync(resolve(import.meta.dirname, "../DataGrid.vue"), "utf8");
const cellDetailPanelSource = readFileSync(resolve(import.meta.dirname, "../DataGridCellDetailPanel.vue"), "utf8");

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
  // 与值编辑器面板相同的挂载形态：variant="inline"、commitOnClose 默认 true、
  // 同一实例持续挂载不卸载（#10667）。
  const Root = defineComponent({
    setup() {
      return () =>
        h(TemporalCellEditor, {
          kind: "datetime",
          variant: "inline",
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

function typeValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

function blurInput(input: HTMLInputElement) {
  input.dispatchEvent(new Event("blur"));
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("TemporalCellEditor blur commit (value editor, #10667)", () => {
  it("commits the draft on blur so the pending change reaches the cell (#10667)", () => {
    const { input, onCommit, modelValue } = mountEditor();

    typeValue(input, "2026-03-04 05:06:07");
    blurInput(input);

    expect(onCommit).toHaveBeenCalledOnce();
    expect(modelValue.value).toBe("2026-03-04 05:06:07");
  });

  it("does not re-commit the blur that follows an explicit commit, then re-arms on the next edit (#10667)", async () => {
    const { input, onCommit } = mountEditor();

    typeValue(input, "2026-03-04 05:06:07");
    keydown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    await nextTick();

    // Enter 提交后紧随的 blur 不能再提交一次（closeHandled 闩锁）。
    blurInput(input);
    expect(onCommit).toHaveBeenCalledTimes(1);

    // 用户重新输入即解除闩锁，之后的失焦提交要重新生效。
    typeValue(input, "2027-07-08 09:10:11");
    blurInput(input);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("keeps the cell details panel temporal editor explicit-commit by design (#10667)", () => {
    // 值编辑器 tab 的 temporal 编辑器与同 tab 的 CodeMirror 编辑器（onBlur →
    // commitValueEditorEdit）对齐：不再传 commit-on-close="false"。
    const valueEditorTemporal = dataGridSource.match(/<TemporalCellEditor[^>]*v-if="detailTemporalEditorConfig"[\s\S]*?\/>/)?.[0] ?? "";
    expect(valueEditorTemporal).toContain('@commit="commitValueEditorEdit"');
    expect(valueEditorTemporal).not.toContain("commit-on-close");

    // 单元格详情 tab 维持显式 确认/取消 交互：其 CodeMirror 同样不失焦提交，
    // 且失焦提交会让点「取消」先于 click 触发一次误提交。
    expect(cellDetailPanelSource).toContain(':commit-on-close="false"');
  });
});
