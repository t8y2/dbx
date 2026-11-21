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

  it.each([3, 1500])("inserts the requested %i rows without truncating the count", async (count) => {
    const onInsert = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(DataGridInsertRowsDialog, {
      open: true,
      canPlaceAtSelection: true,
      onInsert,
    });
    app.use(i18n);
    app.mount(host);
    mountedApps.push({ app, host });

    const input = host.querySelector("#insert-rows-count") as HTMLInputElement;
    input.value = String(count);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    [...host.querySelectorAll("button")].find((button) => button.textContent === "Insert")!.click();
    await nextTick();
    expect(onInsert).toHaveBeenCalledWith(count, "below");
  });

  it.each(["0", "-1", "1.5", "9007199254740992"])("rejects an invalid row count: %s", async (count) => {
    const onInsert = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(DataGridInsertRowsDialog, { open: true, onInsert });
    app.use(i18n);
    app.mount(host);
    mountedApps.push({ app, host });

    const input = host.querySelector("#insert-rows-count") as HTMLInputElement;
    input.value = count;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    const insert = [...host.querySelectorAll("button")].find((button) => button.textContent === "Insert")!;
    expect(insert.disabled).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await nextTick();
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("rejects a request exceeding the remaining grid capacity instead of truncating it", async () => {
    const onInsert = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(DataGridInsertRowsDialog, { open: true, maxRows: 1200, onInsert });
    app.use(i18n);
    app.mount(host);
    mountedApps.push({ app, host });
    const input = host.querySelector("#insert-rows-count") as HTMLInputElement;
    input.value = "1500";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect([...host.querySelectorAll("button")].find((button) => button.textContent === "Insert")!.disabled).toBe(true);
    expect(onInsert).not.toHaveBeenCalled();
  });
});
