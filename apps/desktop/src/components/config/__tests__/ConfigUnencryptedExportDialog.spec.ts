// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return { Dialog: passthrough, DialogContent: passthrough, DialogFooter: passthrough, DialogHeader: passthrough, DialogTitle: passthrough };
});
import ConfigUnencryptedExportDialog from "../ConfigUnencryptedExportDialog.vue";

const apps: App[] = [];
afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = "";
});

async function mountDialog() {
  const includeCredentials = ref(false);
  const busy = ref(false);
  const confirm = vi.fn();
  const cancel = vi.fn();
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(ConfigUnencryptedExportDialog, {
          open: true,
          includeCredentials: includeCredentials.value,
          busy: busy.value,
          "onUpdate:includeCredentials": (value: boolean) => {
            includeCredentials.value = value;
          },
          onConfirm: confirm,
          onCancel: cancel,
        }),
    }),
  );
  apps.push(app);
  app.use(i18n);
  app.mount(root);
  await nextTick();
  return { root, includeCredentials, busy, confirm, cancel };
}

describe("ConfigUnencryptedExportDialog", () => {
  it("starts unchecked, warns about readable credentials, and requires a separate confirm click", async () => {
    const { root, includeCredentials, confirm, cancel } = await mountDialog();
    const checkbox = root.querySelector("input")!;
    expect(checkbox.checked).toBe(false);
    expect(root.textContent).toContain("exclude passwords and other credentials by default");
    expect(root.textContent).toContain("readable by anyone with this file");
    expect(root.textContent).toContain("Export without credentials");
    checkbox.click();
    await nextTick();
    expect(includeCredentials.value).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    const buttons = Array.from(root.querySelectorAll("button"));
    buttons.find((button) => button.textContent?.includes("Export with credentials"))!.click();
    expect(confirm).toHaveBeenCalledOnce();
    buttons.find((button) => button.textContent?.includes("Cancel"))!.click();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("disables the choice and actions while saving", async () => {
    const { root, busy, includeCredentials, confirm, cancel } = await mountDialog();
    busy.value = true;
    await nextTick();
    const checkbox = root.querySelector("input")!;
    expect(checkbox.disabled).toBe(true);
    checkbox.click();
    for (const button of root.querySelectorAll("button")) {
      expect(button.disabled).toBe(true);
      button.click();
    }
    expect(includeCredentials.value).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});
