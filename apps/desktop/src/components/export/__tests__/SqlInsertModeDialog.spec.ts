// @vitest-environment happy-dom

import { createApp, h, nextTick, type App, defineComponent } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => h("div", attrs, slots.default?.());
    },
  });
  return { Dialog: passthrough, DialogContent: passthrough, DialogHeader: passthrough, DialogTitle: passthrough, DialogFooter: passthrough };
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

import SqlInsertModeDialog from "@/components/export/SqlInsertModeDialog.vue";

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  i18n.global.locale.value = "en";
});

async function mountDialog(onConfirm = () => {}, onCancel = () => {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(SqlInsertModeDialog, { open: true, onConfirm, onCancel });
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
}

describe("SqlInsertModeDialog", () => {
  it("defaults to batch mode and emits the selected single-row mode", async () => {
    const onConfirm = vi.fn();
    await mountDialog(onConfirm);

    const batch = document.querySelector<HTMLInputElement>('input[data-sql-insert-mode="batch"]');
    const single = document.querySelector<HTMLInputElement>('input[data-sql-insert-mode="single"]');
    expect(batch?.checked).toBe(true);
    expect(single?.checked).toBe(false);

    single?.click();
    await nextTick();
    document.querySelector<HTMLButtonElement>("[data-sql-insert-mode-confirm]")?.click();

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledWith("single");
  });

  it("renders the batch and single-row explanations", async () => {
    await mountDialog();

    expect(document.body.textContent).toContain("Batch append");
    expect(document.body.textContent).toContain("One row per statement");
    expect(document.body.textContent).toContain("Combine multiple rows into each INSERT statement");
    expect(document.body.textContent).toContain("Write one complete INSERT statement per row");
  });

  it("emits cancel without selecting a mode", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    await mountDialog(onConfirm, onCancel);

    const cancel = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Cancel"));
    cancel?.click();

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
