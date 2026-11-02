// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App, type Component } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogScrollContent } from "@/components/ui/dialog";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { dismissOpenModalSurface, hasOpenModalSurface } from "@/lib/ui/modalSurface";

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

function mount(component: Component) {
  const app = createApp(component);
  mountedApps.push(app);
  app.mount(document.createElement("div"));
  return app;
}

describe("hasOpenModalSurface", () => {
  it("detects the overlay of an open dialog", async () => {
    const open = ref(true);
    mount(defineComponent({ setup: () => () => h(Dialog, { open: open.value }, () => h(DialogContent, {}, () => h("p", "body"))) }));
    await nextTick();

    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay?.getAttribute("data-state")).toBe("open");
    expect(hasOpenModalSurface()).toBe(true);

    open.value = false;
    await nextTick();
    expect(hasOpenModalSurface()).toBe(false);
  });

  it("ignores an overlay that is only finishing its exit animation", () => {
    document.body.innerHTML = '<div data-slot="dialog-overlay" data-state="closed"></div>';
    expect(hasOpenModalSurface()).toBe(false);
  });

  it("ignores non-blocking dialogs that render no overlay", async () => {
    mount(
      defineComponent({
        setup: () => () => h(Dialog, { open: true, modal: false }, () => h(DialogScrollContent, { showOverlay: false }, () => h("p", "body"))),
      }),
    );
    await nextTick();

    const content = document.querySelector('[data-slot="dialog-content"]');
    expect(content?.getAttribute("data-state")).toBe("open");
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    expect(hasOpenModalSurface()).toBe(false);
  });

  it("ignores open popovers that reuse role=dialog", async () => {
    mount(defineComponent({ setup: () => () => h(Popover, { open: true }, () => h(PopoverContent, {}, () => h("p", "body"))) }));
    await nextTick();

    const popover = document.querySelector('[data-slot="popover-content"]');
    expect(popover?.getAttribute("role")).toBe("dialog");
    expect(popover?.getAttribute("data-state")).toBe("open");
    expect(hasOpenModalSurface()).toBe(false);
  });

  it("honours hand-rolled modal opt-in and peek opt-out", () => {
    document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>';
    expect(hasOpenModalSurface()).toBe(true);

    document.body.innerHTML = '<div role="dialog" aria-modal="false"></div>';
    expect(hasOpenModalSurface()).toBe(false);

    document.body.innerHTML = '<div role="alertdialog" aria-label="inline notice"></div>';
    expect(hasOpenModalSurface()).toBe(false);
  });

  it("stays false without a queryable root", () => {
    expect(hasOpenModalSurface(null)).toBe(false);
    expect(hasOpenModalSurface({} as ParentNode)).toBe(false);
  });
});

describe("dismissOpenModalSurface", () => {
  it("lets the top-most layer take the keystroke first, exactly like Esc", async () => {
    const dialogOpen = ref(true);
    const popoverOpen = ref(true);
    mount(
      defineComponent({
        setup: () => () =>
          h(Dialog, { open: dialogOpen.value, "onUpdate:open": (value: boolean) => (dialogOpen.value = value) }, () =>
            h(DialogContent, {}, () => [h(Popover, { open: popoverOpen.value, "onUpdate:open": (value: boolean) => (popoverOpen.value = value) }, () => h(PopoverContent, {}, () => h("p", "popover")))]),
          ),
      }),
    );
    await nextTick();

    expect(dismissOpenModalSurface()).toBe(true);
    await nextTick();

    // The popover above the dialog absorbs the keystroke, so the dialog stays open --
    // same as pressing Esc once. (The next press reaches the dialog once the popover's
    // exit animation has unmounted its layer, which happy-dom cannot run.)
    expect(popoverOpen.value).toBe(false);
    expect(dialogOpen.value).toBe(true);
    expect(hasOpenModalSurface()).toBe(true);
  });

  it("closes the dialog that owns the window", async () => {
    const open = ref(true);
    mount(
      defineComponent({
        setup: () => () => h(Dialog, { open: open.value, "onUpdate:open": (value: boolean) => (open.value = value) }, () => h(DialogContent, {}, () => h("p", "body"))),
      }),
    );
    await nextTick();

    expect(dismissOpenModalSurface()).toBe(true);
    await nextTick();

    expect(open.value).toBe(false);
    expect(hasOpenModalSurface()).toBe(false);
  });

  it("leaves the window alone when no modal is open", () => {
    const dispatched: Event[] = [];
    const target = { dispatchEvent: (event: Event) => dispatched.push(event) } as unknown as Window;

    expect(dismissOpenModalSurface(target)).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it("stays inert without a dispatch target", () => {
    document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>';

    expect(dismissOpenModalSurface(null)).toBe(false);
    expect(hasOpenModalSurface()).toBe(true);
  });
});
