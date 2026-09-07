// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  saveTextFile: vi.fn().mockResolvedValue(undefined),
  toast: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: mocks.copyToClipboard }));
vi.mock("@/lib/export/saveTextFile", () => ({ saveTextFile: mocks.saveTextFile }));

// The real Dialog portals its content only while open; we stub it as a
// transparent DOM passthrough that mirrors that gating (slot only rendered when
// `open` is true) and that closes through Vue's emit mechanism when clicked.
// This mirrors the CodeSnapshotDialog.spec.ts stub approach.
vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return {
    Dialog: defineComponent({
      props: { open: Boolean },
      emits: ["update:open"],
      setup(props, { emit, slots }) {
        return () => h("div", { "data-open": String(props.open), onClick: () => emit("update:open", false) }, props.open ? slots.default?.() : undefined);
      },
    }),
    DialogContent: passthrough,
    DialogHeader: passthrough,
    DialogTitle: defineComponent({
      setup(_props, { slots }) {
        return () => h("div", { "data-slot": "dialog-title" }, slots.default?.());
      },
    }),
    DialogDescription: passthrough,
  };
});

import { buildSafeHtmlPreview } from "@/lib/ai/richContent/aiHtmlPreview";
import type { App } from "vue";
import { createApp, nextTick } from "vue";

const content = "<p>Hello <strong>world</strong></p>";
const documentHtml = buildSafeHtmlPreview(content);

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function mountPreview() {
  // Dynamic import after resetModules so each test starts with a fresh copy-risk session state.
  const { default: AiHtmlPreview } = await import("@/components/ai/rich/AiHtmlPreview.vue");
  app = createApp(AiHtmlPreview, { content, document: documentHtml });
  root = window.document.createElement("div");
  window.document.body.appendChild(root);
  app.mount(root);
  await nextTick();
  await nextTick();
}

function unmount() {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
}

function button(title: string): HTMLButtonElement | null {
  return root?.querySelector(`button[aria-label="${title}"]`) ?? null;
}

function copyButton() {
  return button("ai.htmlCopySource");
}

function confirmStrip(): Element | null {
  return root?.querySelector('[role="alertdialog"]') ?? null;
}

async function click(element: HTMLElement | null) {
  element?.dispatchEvent(new window.Event("click", { bubbles: true }));
  await nextTick();
  await nextTick();
}

beforeEach(() => {
  vi.resetModules();
  mocks.copyToClipboard.mockClear();
  mocks.saveTextFile.mockClear();
  mocks.toast.mockClear();
  unmount();
});

describe("AiHtmlPreview", () => {
  it("renders a fully sandboxed iframe over the CSP-wrapped document", async () => {
    await mountPreview();
    const iframe = root?.querySelector("iframe");
    expect(iframe).not.toBeNull();
    // `sandbox=""` without allow-scripts / allow-same-origin: nothing may execute.
    expect(iframe?.getAttribute("sandbox")).toBe("");
    const srcdoc = iframe?.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("Content-Security-Policy");
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain(content);
  });

  it("asks before the first source copy and cancel keeps the clipboard untouched", async () => {
    await mountPreview();
    await click(copyButton());
    expect(confirmStrip()).not.toBeNull();
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    // Cancel = the first (non-destructive) button in the strip.
    const cancel = [...(confirmStrip()?.querySelectorAll("button") ?? [])][0];
    await click(cancel);
    expect(confirmStrip()).toBeNull();
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
  });

  it("copies after explicit confirmation and remembers the choice for the session", async () => {
    await mountPreview();
    await click(copyButton());
    const strip = confirmStrip();
    expect(strip).not.toBeNull();
    const checkbox = strip?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (checkbox) {
      checkbox.checked = true;
      // v-model needs the change event, not just the property write.
      checkbox.dispatchEvent(new window.Event("change"));
      await nextTick();
    }
    const buttons = [...(strip?.querySelectorAll("button") ?? [])];
    await click(buttons[buttons.length - 1]);
    expect(mocks.copyToClipboard).toHaveBeenCalledWith(content);
    expect(confirmStrip()).toBeNull();

    // A later copy in the same session — even from a freshly mounted preview —
    // skips the confirmation and shows only the risk toast.
    mocks.copyToClipboard.mockClear();
    unmount();
    await mountPreview();
    await click(copyButton());
    expect(confirmStrip()).toBeNull();
    expect(mocks.copyToClipboard).toHaveBeenCalledWith(content);
    expect(mocks.toast).toHaveBeenCalledWith("ai.htmlCopyRiskToast");
  });

  it("opens the same sandboxed document in an expanded dialog and closes it", async () => {
    await mountPreview();
    expect(root?.querySelectorAll("iframe").length).toBe(1);

    await click(button("ai.htmlExpandPreview"));
    // The stub Dialog renders inline; the second iframe carries the same
    // sandbox boundary and the same CSP-wrapped srcdoc as the inline card.
    const iframes = [...(root?.querySelectorAll("iframe") ?? [])];
    expect(iframes.length).toBe(2);
    const dialogIframe = iframes[1];
    expect(dialogIframe.getAttribute("sandbox")).toBe("");
    const srcdoc = dialogIframe.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("Content-Security-Policy");
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain(content);
    // The wide preview must override DialogContent's max-w-sm at every
    // breakpoint, including narrow desktop windows and mobile-sized WebViews.
    expect(root?.innerHTML).toContain("max-w-[min(1100px,calc(100vw-32px))]");
    // The dialog title is the same preview label used for the inline card.
    expect(root?.querySelector('[data-slot="dialog-title"]')?.textContent).toBe("ai.htmlPreviewLabel");

    // Closing (Esc / overlay / programmatic update:open) removes the iframe.
    const dialog = root?.querySelector('[data-open="true"]');
    await click(dialog);
    expect(root?.querySelectorAll("iframe").length).toBe(1);
  });

  it("writes the wrapped safe document, never the raw source", async () => {
    await mountPreview();
    await click(button("ai.htmlSaveSafe"));
    expect(mocks.saveTextFile).toHaveBeenCalledWith(documentHtml, "dbx-ai-html-preview.html", "HTML", "html");
    expect(mocks.saveTextFile.mock.calls[0][0]).not.toBe(content);
  });

  it("suppresses the risk toast when the clipboard write fails", async () => {
    await mountPreview();
    // Arm the remembered session acknowledgment, mirroring the existing flow.
    await click(copyButton());
    const strip = confirmStrip();
    expect(strip).not.toBeNull();
    const checkbox = strip?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (checkbox) {
      checkbox.checked = true;
      checkbox.dispatchEvent(new window.Event("change"));
      await nextTick();
    }
    const buttons = [...(strip?.querySelectorAll("button") ?? [])];
    await click(buttons[buttons.length - 1]);
    expect(mocks.copyToClipboard).toHaveBeenCalledWith(content);

    // A later copy in the same session skips the confirmation — but this time
    // the clipboard write fails, so the risk toast must not claim success.
    // (Regression for #I01: the previous code toasted unconditionally.)
    mocks.copyToClipboard.mockRejectedValueOnce(new Error("denied"));
    mocks.toast.mockClear();
    unmount();
    await mountPreview();
    await click(copyButton());
    expect(confirmStrip()).toBeNull();
    expect(mocks.copyToClipboard).toHaveBeenCalledWith(content);
    expect(mocks.toast).not.toHaveBeenCalled();
    // The failure is still silent (doCopy swallows), so the "copied" checkmark
    // must not appear either — no false success signal at all.
    expect(root?.querySelector(".text-green-500")).toBeNull();
  });
});
