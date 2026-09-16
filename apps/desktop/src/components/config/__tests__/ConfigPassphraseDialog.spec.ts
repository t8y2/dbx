// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      props: { disabled: Boolean },
      emits: ["click"],
      setup(props, { slots, emit }) {
        return () => h("button", { disabled: props.disabled, onClick: () => emit("click") }, slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/label", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Label: defineComponent({
      setup(_props, { slots }) {
        return () => h("label", slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/PasswordInput.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { modelValue: String, disabled: Boolean },
      emits: ["update:modelValue"],
      setup(props, { emit }) {
        return () => h("input", { value: props.modelValue, disabled: props.disabled, onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value) });
      },
    }),
  };
});

vi.mock("@lucide/vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Lock: defineComponent({
      setup() {
        return () => h("span");
      },
    }),
  };
});

import ConfigPassphraseDialog from "@/components/config/ConfigPassphraseDialog.vue";
import { clearRememberedExportPassphrase, rememberExportPassphrase } from "@/lib/backend/exportPassphraseSession";

const mountedApps: App[] = [];

beforeEach(() => {
  clearRememberedExportPassphrase();
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
});

async function mountDialog(props: Record<string, unknown>) {
  i18n.global.locale.value = "en";
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(ConfigPassphraseDialog, props);
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
}

describe("ConfigPassphraseDialog", () => {
  it("offers unencrypted export as an explicit secondary action", async () => {
    const requestUnencrypted = vi.fn();
    const confirm = vi.fn();
    await mountDialog({ open: true, mode: "export", onRequestUnencrypted: requestUnencrypted, onConfirm: confirm });

    const buttons = [...document.body.querySelectorAll("button")];
    const unencrypted = buttons.find((button) => button.textContent?.includes("Export without encryption"));
    expect(unencrypted).toBeTruthy();
    unencrypted?.click();
    expect(requestUnencrypted).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not allow an empty encrypted passphrase", async () => {
    const confirm = vi.fn();
    await mountDialog({ open: true, mode: "export", onConfirm: confirm });

    const encrypted = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("Export encrypted"));
    encrypted?.click();
    await nextTick();
    expect(confirm).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Passphrase is required");
  });

  it("blocks encrypted export when the confirmation passphrase does not match", async () => {
    const confirm = vi.fn();
    await mountDialog({ open: true, mode: "export", onConfirm: confirm });

    const [passphraseInput, confirmInput] = [...document.body.querySelectorAll("input")];
    passphraseInput.value = "correct-pass";
    passphraseInput.dispatchEvent(new Event("input"));
    confirmInput.value = "mismatched-pass";
    confirmInput.dispatchEvent(new Event("input"));

    const encrypted = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("Export encrypted"));
    encrypted?.click();
    await nextTick();

    expect(confirm).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Passphrases do not match");
  });

  it("confirms encrypted export when both passphrase entries match", async () => {
    const confirm = vi.fn();
    await mountDialog({ open: true, mode: "export", onConfirm: confirm });

    const [passphraseInput, confirmInput] = [...document.body.querySelectorAll("input")];
    passphraseInput.value = "matching-pass";
    passphraseInput.dispatchEvent(new Event("input"));
    confirmInput.value = "matching-pass";
    confirmInput.dispatchEvent(new Event("input"));

    const encrypted = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("Export encrypted"));
    encrypted?.click();
    await nextTick();

    expect(confirm).toHaveBeenCalledWith("matching-pass");
  });

  it("prefills the session-remembered passphrase into both export fields", async () => {
    rememberExportPassphrase("session-pass");
    await mountDialog({ open: true, mode: "export", onConfirm: vi.fn() });

    expect([...document.body.querySelectorAll("input")].map((input) => input.value)).toEqual(["session-pass", "session-pass"]);
  });

  it("never prefills the passphrase in import mode", async () => {
    rememberExportPassphrase("session-pass");
    await mountDialog({ open: true, mode: "import", onConfirm: vi.fn() });

    expect([...document.body.querySelectorAll("input")].map((input) => input.value)).toEqual([""]);
  });

  it("keeps import mode free of the unencrypted export action", async () => {
    await mountDialog({ open: true, mode: "import", onConfirm: vi.fn() });

    expect(document.body.textContent).not.toContain("Export without encryption");
    expect(document.body.textContent).toContain("Decrypt");
  });
});
