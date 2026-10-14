// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { passwordViewerEnabled } from "@/lib/security/passwordViewer";
import i18n, { loadLocaleMessages, type Locale } from "@/i18n";

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
const locales: Locale[] = ["az", "en", "es", "id", "it", "ja", "ko", "pt-BR", "ru", "tr", "zh-CN", "zh-TW"];
const warningKeys = ["plaintextDefaultDescription", "credentialsUnavailable", "includeCredentials", "plaintextCredentialsWarning", "exportWithCredentials", "exportWithoutCredentials"];
beforeAll(async () => {
  await Promise.all(locales.map(loadLocaleMessages));
}, 60_000);
beforeEach(() => {
  i18n.global.locale.value = "en";
  passwordViewerEnabled.value = true;
});
afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = "";
  passwordViewerEnabled.value = true;
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
  it.each(locales)("renders native safety warnings and both export choices in %s", async (locale) => {
    i18n.global.locale.value = locale;
    for (const key of warningKeys) expect(i18n.global.te(`configExport.${key}`, locale)).toBe(true);
    const { root } = await mountDialog();
    expect(root.textContent).toContain(i18n.global.t("configExport.plaintextDefaultDescription"));
    expect(root.textContent).toContain(i18n.global.t("configExport.includeCredentials"));
    expect(root.textContent).toContain(i18n.global.t("configExport.plaintextCredentialsWarning"));
    expect(root.textContent).toContain(i18n.global.t("configExport.exportWithoutCredentials"));
    root.querySelector("input")!.click();
    await nextTick();
    expect(root.textContent).toContain(i18n.global.t("configExport.exportWithCredentials"));
  });

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

  it("disables credential export when the server disallows password viewing and clears an existing choice", async () => {
    const { root, includeCredentials } = await mountDialog();
    root.querySelector("input")!.click();
    await nextTick();
    expect(includeCredentials.value).toBe(true);
    passwordViewerEnabled.value = false;
    await nextTick();
    expect(includeCredentials.value).toBe(false);
    const checkbox = root.querySelector("input")!;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);
    checkbox.click();
    expect(includeCredentials.value).toBe(false);
    expect(root.textContent).toContain("This server does not allow exporting credentials.");
    expect(root.textContent).toContain("Export without credentials");
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
