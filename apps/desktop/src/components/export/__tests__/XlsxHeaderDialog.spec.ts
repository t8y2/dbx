// @vitest-environment happy-dom

import { createApp, nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import XlsxHeaderDialog from "../XlsxHeaderDialog.vue";

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

  it("emits the combined name and comment mode", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let selectedMode = "";
    const app = createApp(XlsxHeaderDialog, {
      open: true,
      onConfirm: (mode: string) => {
        selectedMode = mode;
      },
    });
    app.use(i18n);
    app.mount(container);
    await nextTick();

    document.querySelector<HTMLInputElement>('input[value="name-comment"]')!.click();
    await nextTick();
    document.querySelector<HTMLButtonElement>("[data-xlsx-header-confirm]")!.click();
    await nextTick();

    expect(selectedMode).toBe("name-comment");
    app.unmount();
  });
});
