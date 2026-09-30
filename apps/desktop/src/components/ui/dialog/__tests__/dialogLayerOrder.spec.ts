// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type Component } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";

const mountedApps: Array<{ unmount: () => void; host: HTMLElement }> = [];

afterEach(() => {
  for (const { unmount, host } of mountedApps.splice(0)) {
    unmount();
    host.remove();
  }
  document.body.innerHTML = "";
});

async function flush() {
  for (let turn = 0; turn < 5; turn += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
  }
}

type Layer = { index: number; slot: string; label: string; element: Element };

/** Dialog layers teleport into `body`, so paint order is their order among the body children. */
function dialogLayers(): Layer[] {
  return Array.from(document.body.children)
    .map((element, index) => ({
      index,
      element,
      slot: element.getAttribute("data-slot") || "",
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

function overlayBefore(target: Layer): Layer | undefined {
  return dialogLayers().find((candidate) => candidate.slot === "dialog-overlay" && candidate.index === target.index - 1);
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

    // The transfer form and its confirmation paint in open order to begin with.
    const transfer = layer("dialog-positioner", "transfer form");
    const confirm = layer("dialog-positioner", "confirm transfer");
    expect(confirm.index).toBeGreaterThan(transfer.index);
    expect(overlayBefore(confirm)).toBeDefined();

    // A dialog that gets remounted (leaving the tracked-transfer dialog and returning to the form)
    // ends up after the dialog it is supposed to sit below; Reka UI then keeps handing pointer
    // events to the confirmation dialog while the form's backdrop covers it.
    const transferOverlay = transfer.element.previousElementSibling!;
    document.body.append(transferOverlay, transfer.element);
    await flush();
    expect(layer("dialog-positioner", "transfer form").index).toBeGreaterThan(layer("dialog-positioner", "confirm transfer").index);

    // Reopening the confirmation must bring its layer back above the form.
    state.confirmOpen = false;
    await flush();
    state.confirmOpen = true;
    await flush();

    const reopened = layer("dialog-positioner", "confirm transfer");
    expect(reopened.index).toBeGreaterThan(layer("dialog-positioner", "transfer form").index);
    expect(document.body.lastElementChild).toBe(reopened.element);
    expect(overlayBefore(reopened)).toBeDefined();
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

    expect(layer("dialog-positioner", "confirm transfer").index).toBeGreaterThan(layer("dialog-positioner", "transfer form").index);
  });
});
