// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return {
    Dialog: passthrough,
    DialogContent: passthrough,
    DialogDescription: passthrough,
    DialogFooter: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
  };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      inheritAttrs: false,
      setup(_props, { attrs, slots }) {
        return () => h("button", attrs, slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Input: defineComponent({
      inheritAttrs: false,
      props: { modelValue: String },
      emits: ["update:modelValue"],
      setup(props, { attrs, emit }) {
        return () => h("input", { ...attrs, value: props.modelValue, onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value) });
      },
    }),
  };
});

import DataGridInsertRowsDialog from "../DataGridInsertRowsDialog.vue";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGridInsertRowsDialog", () => {
  it("uses the configured end position when first mounted open", async () => {
    const onInsert = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(DataGridInsertRowsDialog, {
      open: true,
      canPlaceAtSelection: true,
      initialPosition: "end",
      onInsert,
    });
    app.use(i18n);
    app.mount(host);
    mountedApps.push({ app, host });

    await nextTick();
    expect((host.querySelector('input[value="end"]') as HTMLInputElement).checked).toBe(true);

    [...host.querySelectorAll("button")].find((button) => button.textContent === "Insert")!.click();
    await nextTick();
    expect(onInsert).toHaveBeenCalledWith(1, "end");
  });
});
