// @vitest-environment happy-dom

import { createApp, nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import XlsxHeaderDialog from "../XlsxHeaderDialog.vue";
import type { XlsxExportOptions } from "@/lib/export/xlsxHeader";

describe("XlsxHeaderDialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("emits cancel when the built-in close button dismisses the dialog", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let cancelCount = 0;
    const app = createApp(XlsxHeaderDialog, {
      open: true,
      onCancel: () => {
        cancelCount += 1;
      },
    });
    app.use(i18n);
    app.mount(container);
    await nextTick();

    document.querySelector<HTMLElement>('[data-slot="dialog-close"]')!.click();
    await nextTick();

    expect(cancelCount).toBe(1);
    app.unmount();
  });

  it("emits the selected header mode and filter option", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let selectedOptions: { headerMode: string; autoFilter: boolean } | undefined;
    const app = createApp(XlsxHeaderDialog, {
      open: true,
      onConfirm: (options: { headerMode: string; autoFilter: boolean }) => {
        selectedOptions = options;
      },
    });
    app.use(i18n);
    app.mount(container);
    await nextTick();

    document.querySelector<HTMLInputElement>('input[value="name-comment"]')!.click();
    await nextTick();
    document.querySelector<HTMLButtonElement>("[data-xlsx-header-confirm]")!.click();
    await nextTick();

    expect(selectedOptions).toEqual({ headerMode: "name-comment", autoFilter: false });
    app.unmount();
  });

  it("selects queued execution in the existing options confirmation, defaulting to immediate", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let selectedOptions: XlsxExportOptions | undefined;
    const app = createApp(XlsxHeaderDialog, {
      open: true,
      showExecutionMode: true,
      onConfirm: (options: XlsxExportOptions) => {
        selectedOptions = options;
      },
    });
    app.use(i18n);
    app.mount(container);
    await nextTick();
    expect(document.querySelector<HTMLInputElement>('input[value="immediate"]')!.checked).toBe(true);
    document.querySelector<HTMLInputElement>('input[value="queued"]')!.click();
    await nextTick();
    document.querySelector<HTMLButtonElement>("[data-xlsx-header-confirm]")!.click();
    await nextTick();
    expect(selectedOptions).toEqual({ headerMode: "name", autoFilter: false, executionMode: "queued" });
    app.unmount();
  });
});
