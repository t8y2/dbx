// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp, defineComponent, h, nextTick, reactive, type Component } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";
import { useFloatingLayerOrder } from "@/components/ui/dialog/useDialogLayerOrder";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const mountedApps: Array<{ unmount: () => void; host: HTMLElement }> = [];
const mountedStyles: HTMLStyleElement[] = [];
const floatingLayerRule = readFileSync(resolve(process.cwd(), "apps/desktop/src/styles/globals.css"), "utf8").match(/\[data-dbx-floating-layer\]\s*\{[^}]+\}/)?.[0];

if (!floatingLayerRule) {
  throw new Error("globals.css is missing the floating layer z-index rule");
}

afterEach(() => {
  for (const { unmount, host } of mountedApps.splice(0)) {
    unmount();
    host.remove();
  }
  for (const style of mountedStyles.splice(0)) {
    style.remove();
  }
  document.body.innerHTML = "";
});

function installFloatingLayerStyles() {
  const style = document.createElement("style");
  style.textContent = floatingLayerRule;
  document.head.append(style);
  mountedStyles.push(style);
}

async function flush() {
  for (let turn = 0; turn < 5; turn += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
  }
}

type Layer = { index: number; slot: string; label: string; zIndex: number; element: Element };

/** Dialog layers teleport into `body`; their visual order is controlled by z-index. */
function dialogLayers(): Layer[] {
  return Array.from(document.body.children)
    .map((element, index) => ({
      index,
      element,
      slot: element.getAttribute("data-slot") || "",
      zIndex: Number.parseInt((element as HTMLElement).style.zIndex || "0", 10),
      label: (element.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/Close$/, ""),
    }))
    .filter((layer) => layer.slot === "dialog-overlay" || layer.slot === "dialog-positioner");
}

function layer(slot: string, label?: string): Layer {
  const match = dialogLayers().find((candidate) => candidate.slot === slot && (!label || candidate.label.includes(label)));
  expect(match, `no ${slot} painted for ${label ?? ""}`).toBeDefined();
  return match!;
}

function layers(slot: string): Layer[] {
  return dialogLayers().filter((candidate) => candidate.slot === slot);
}

function labeledDialog(options: { open: () => boolean; setOpen: (open: boolean) => void; label: string; content: Component }) {
  const { open, setOpen, label, content } = options;
  return h(
    Dialog,
    { open: open(), "onUpdate:open": setOpen },
    {
      default: () =>
        h(
          content,
          {},
          {
            default: () => [h(DialogTitle, null, { default: () => label })],
          },
        ),
    },
  );
}

/** Two sibling dialogs, like the transfer form and its "start transfer" confirmation. */
function mountSiblingDialogs(content: Component = DialogContent) {
  const host = document.createElement("div");
  document.body.append(host);
  const state = reactive({ transferOpen: false, confirmOpen: false });
  const app = createApp(
    defineComponent({
      setup() {
        const transfer = () =>
          labeledDialog({
            open: () => state.transferOpen,
            setOpen: (open) => {
              state.transferOpen = open;
            },
            label: "transfer form",
            content,
          });
        const confirm = () =>
          labeledDialog({
            open: () => state.confirmOpen,
            setOpen: (open) => {
              state.confirmOpen = open;
            },
            label: "confirm transfer",
            content,
          });
        return () => h("div", [transfer(), confirm()]);
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mountedApps.push({ unmount: () => app.unmount(), host });
  return state;
}

describe("dialog layer order", () => {
  it.each([
    ["DialogContent", DialogContent],
    ["DialogScrollContent", DialogScrollContent],
  ])("paints a %s that opens later above layers left behind by earlier dialogs", async (_name, content) => {
    const state = mountSiblingDialogs(content);
    state.transferOpen = true;
    await flush();
    state.confirmOpen = true;
    await flush();

    // The transfer form and its confirmation receive layers in open order to begin with.
    const transfer = layer("dialog-positioner", "transfer form");
    const confirm = layer("dialog-positioner", "confirm transfer");
    expect(confirm.zIndex).toBeGreaterThan(transfer.zIndex);
    expect(
      layers("dialog-overlay")
        .map(({ zIndex }) => zIndex)
        .sort(),
    ).toEqual([transfer.zIndex, confirm.zIndex].sort());

    // Reparenting a portal node must not change which dialog is visually on top.
    const transferOverlay = transfer.element.previousElementSibling!;
    document.body.append(transferOverlay, transfer.element);
    await flush();
    expect(layer("dialog-positioner", "confirm transfer").zIndex).toBeGreaterThan(layer("dialog-positioner", "transfer form").zIndex);

    // Reopening the confirmation must bring its layer back above the form.
    state.confirmOpen = false;
    await flush();
    state.confirmOpen = true;
    await flush();

    const reopened = layer("dialog-positioner", "confirm transfer");
    expect(reopened.zIndex).toBeGreaterThan(layer("dialog-positioner", "transfer form").zIndex);
  });

  it("paints a nested dialog above the dialog that opened it", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const state = reactive({ formOpen: true, confirmOpen: false });
    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            labeledDialog({
              open: () => state.formOpen,
              setOpen: (open) => {
                state.formOpen = open;
              },
              label: "transfer form",
              content: defineComponent({
                setup() {
                  return () =>
                    h(DialogContent, null, {
                      default: () => [
                        h(DialogTitle, null, { default: () => "transfer form" }),
                        labeledDialog({
                          open: () => state.confirmOpen,
                          setOpen: (open) => {
                            state.confirmOpen = open;
                          },
                          label: "confirm transfer",
                          content: DialogContent,
                        }),
                      ],
                    });
                },
              }),
            });
        },
      }),
    );
    app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
    app.mount(host);
    mountedApps.push({ unmount: () => app.unmount(), host });
    await flush();

    state.confirmOpen = true;
    await flush();

    const transfer = layer("dialog-positioner", "transfer form");
    const confirm = layer("dialog-positioner", "confirm transfer");
    expect(transfer.zIndex).toBeGreaterThan(50);
    expect(confirm.zIndex).toBeGreaterThan(transfer.zIndex);
  });

  it("resets the layer sequence after all dialogs close", async () => {
    const state = mountSiblingDialogs();

    state.transferOpen = true;
    await flush();
    expect(layer("dialog-positioner", "transfer form").zIndex).toBe(51);

    state.transferOpen = false;
    await flush();
    expect(document.documentElement.style.getPropertyValue("--dbx-dialog-top-z-index")).toBe("50");
    expect(document.documentElement.style.getPropertyValue("--dbx-floating-layer-z-index")).toBe("51");

    state.transferOpen = true;
    await flush();
    expect(layer("dialog-positioner", "transfer form").zIndex).toBe(51);
  });

  it("exposes a floating layer above the open dialog", async () => {
    installFloatingLayerStyles();
    const host = document.createElement("div");
    document.body.append(host);
    const state = reactive({ dialogOpen: true, selectOpen: false });
    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h("div", [
              h(
                Dialog,
                { open: state.dialogOpen, "onUpdate:open": (open: boolean) => (state.dialogOpen = open) },
                {
                  default: () =>
                    h(DialogContent, null, {
                      default: () => [
                        h(DialogTitle, null, { default: () => "settings" }),
                        h(
                          Select,
                          { open: state.selectOpen, "onUpdate:open": (open: boolean) => (state.selectOpen = open) },
                          {
                            default: () => [h(SelectTrigger, null, { default: () => h(SelectValue, { placeholder: "Choose" }) }), h(SelectContent, null, { default: () => h(SelectItem, { value: "one" }, { default: () => "One" }) })],
                          },
                        ),
                      ],
                    }),
                },
              ),
            ]);
        },
      }),
    );
    app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
    app.mount(host);
    mountedApps.push({ unmount: () => app.unmount(), host });
    await flush();

    const dialog = layer("dialog-positioner", "settings");
    state.selectOpen = true;
    await flush();

    const selectContent = document.body.querySelector<HTMLElement>('[data-slot="select-content"]');
    const popperWrapper = document.body.querySelector<HTMLElement>("[data-reka-popper-content-wrapper]");
    expect(selectContent).not.toBeNull();
    expect(popperWrapper?.hasAttribute("data-dbx-floating-layer")).toBe(true);
    expect(selectContent?.className).toContain("z-(--dbx-floating-layer-z-index)");
    expect(Number(document.documentElement.style.getPropertyValue("--dbx-floating-layer-z-index"))).toBe(dialog.zIndex + 1);
    expect(getComputedStyle(popperWrapper!).zIndex).toContain(String(dialog.zIndex + 1));
  });

  it("preserves an explicit floating layer z-index", async () => {
    installFloatingLayerStyles();
    const host = document.createElement("div");
    document.body.append(host);
    const FloatingProbe = defineComponent({
      setup() {
        const { forwardRef } = useFloatingLayerOrder();
        return () => h("div", { ref: forwardRef, "data-reka-popper-content-wrapper": "", style: { zIndex: "80" } }, h("div", { style: { zIndex: "80" } }));
      },
    });
    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(
              Dialog,
              { open: true },
              {
                default: () =>
                  h(DialogContent, null, {
                    default: () => [h(DialogTitle, null, { default: () => "settings" }), h(FloatingProbe)],
                  }),
              },
            );
        },
      }),
    );
    app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
    app.mount(host);
    mountedApps.push({ unmount: () => app.unmount(), host });
    await flush();

    const popperWrapper = document.body.querySelector<HTMLElement>("[data-reka-popper-content-wrapper]");
    expect(popperWrapper?.style.getPropertyValue("--dbx-floating-content-z-index")).toBe("80");
    expect(getComputedStyle(popperWrapper!).zIndex).toContain("80");
  });
});

describe("non-modal floating dialogs", () => {
  it("leaves the background interactive and stays open when it receives focus", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const state = reactive({ open: true, clicks: 0 });
    const app = createApp(
      defineComponent({
        setup: () => () => [
          h("button", { id: "background-action", onClick: () => state.clicks++ }, "Background"),
          h(
            Dialog,
            {
              open: state.open,
              modal: false,
              "onUpdate:open": (value: boolean) => {
                state.open = value;
              },
            },
            {
              default: () =>
                h(
                  DialogContent,
                  { onInteractOutside: (event: Event) => event.preventDefault() },
                  {
                    default: () => h(DialogTitle, null, { default: () => "Floating export" }),
                  },
                ),
            },
          ),
        ],
      }),
    );
    app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} } }));
    app.mount(host);
    mountedApps.push({ unmount: () => app.unmount(), host });
    await flush();
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    expect(document.body.style.pointerEvents).not.toBe("none");
    const button = host.querySelector<HTMLButtonElement>("#background-action")!;
    expect(button.closest('[aria-hidden="true"]')).toBeNull();
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    button.focus();
    button.click();
    await flush();
    expect(state.open).toBe(true);
    expect(state.clicks).toBe(1);
    expect(document.activeElement).toBe(button);
  });
});
