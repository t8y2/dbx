// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import TableColumnPasteDialog from "@/components/structure/TableColumnPasteDialog.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import en from "@/i18n/locales/en";

let app: App | undefined;

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
});

async function mountDialog() {
  const state = reactive({ open: true });
  const imported = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({
    setup: () => () =>
      h(
        TooltipProvider,
        {},
        {
          default: () =>
            h(TableColumnPasteDialog, {
              open: state.open,
              disabled: false,
              existingNames: [],
              "onUpdate:open": (open: boolean) => {
                state.open = open;
              },
              onImport: imported,
            }),
        },
      ),
  });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en } }));
  app.mount(host);
  await vi.waitFor(() => expect(document.querySelector("[data-column-paste-input]")).not.toBeNull());
  await nextTick();
  return { state, imported };
}

describe("TableColumnPasteDialog keyboard handling with the real dialog", () => {
  it.each(["[data-column-paste-input]", "[data-slot='dialog-close']"])("closes on Escape focused on %s without importing", async (selector) => {
    const { state, imported } = await mountDialog();
    const target = document.querySelector<HTMLElement>(selector)!;
    target.focus();
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    expect(state.open).toBe(false);
    expect(imported).not.toHaveBeenCalled();
  });

  it.each(["ctrlKey", "metaKey"] as const)("keeps %s+S from reaching the underlying editor", async (modifier) => {
    const { state, imported } = await mountDialog();
    const save = vi.fn();
    window.addEventListener("keydown", save);
    try {
      const target = document.querySelector<HTMLTextAreaElement>("[data-column-paste-input]")!;
      target.focus();
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "s", [modifier]: true, bubbles: true, cancelable: true }));
      await nextTick();
      expect(save).not.toHaveBeenCalled();
      expect(state.open).toBe(true);
      expect(imported).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", save);
    }
  });

  it("previews and imports a batch containing numeric and bit defaults", async () => {
    const { imported } = await mountDialog();
    const input = document.querySelector<HTMLTextAreaElement>("[data-column-paste-input]")!;
    const sql = "ratio FLOAT DEFAULT 1e3, amount DECIMAL(10,2) DEFAULT .5, flag BIT(1) DEFAULT b'0'";
    input.value = sql;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(document.querySelectorAll("tbody tr")).toHaveLength(3);
    const submit = document.querySelector<HTMLButtonElement>("[data-column-paste-submit]")!;
    expect(submit.disabled).toBe(false);
    submit.click();
    expect(imported).toHaveBeenCalledExactlyOnceWith(sql);
  });
});
