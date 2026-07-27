// @vitest-environment happy-dom

import { CalendarDateTime } from "@internationalized/date";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import DateTimePicker from "./DateTimePicker.vue";

const mountedApps: Array<{ unmount: () => void; host: HTMLElement }> = [];

afterEach(() => {
  for (const { unmount, host } of mountedApps.splice(0)) {
    unmount();
    host.remove();
  }
});

function mountPickerInDialog() {
  const host = document.createElement("div");
  document.body.append(host);
  const update = vi.fn();
  const app = createApp(
    defineComponent({
      setup() {
        const dialogOpen = ref(true);
        return () =>
          h(
            Dialog,
            {
              open: dialogOpen.value,
              "onUpdate:open": (open: boolean) => {
                dialogOpen.value = open;
              },
            },
            {
              default: () =>
                h(
                  DialogContent,
                  { showCloseButton: false },
                  {
                    default: () => [
                      h(DialogTitle, null, { default: () => "Create key" }),
                      h("button", { type: "button", "data-dialog-outside": true }, "Dialog action"),
                      h(DateTimePicker, {
                        modelValue: new CalendarDateTime(2024, 2, 28, 8, 9, 10),
                        "onUpdate:modelValue": update,
                      }),
                    ],
                  },
                ),
            },
          );
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mountedApps.push({ unmount: () => app.unmount(), host });
  return { update };
}

async function waitForPopover() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve));
  await nextTick();
}

describe("DateTimePicker in a dialog", () => {
  it("opens its teleported picker when the trigger is clicked", async () => {
    mountPickerInDialog();
    await nextTick();
    const trigger = document.querySelector<HTMLButtonElement>("[data-date-time-picker-trigger]");

    expect(trigger).not.toBeNull();
    trigger!.click();
    await waitForPopover();

    const content = document.querySelector<HTMLElement>("[data-date-time-picker-content]");
    expect(content).not.toBeNull();
    expect(content?.getAttribute("data-state")).toBe("open");
  });

  it("uses a roving date grid that supports arrow-key navigation", async () => {
    mountPickerInDialog();
    await nextTick();
    document.querySelector<HTMLButtonElement>("[data-date-time-picker-trigger]")!.click();
    await waitForPopover();

    const grid = document.querySelector<HTMLElement>("[data-date-time-picker-content] [role='grid']");
    const currentDay = document.querySelector<HTMLButtonElement>("[data-date-time-picker-day='2024-02-28']");
    const nextDay = document.querySelector<HTMLButtonElement>("[data-date-time-picker-day='2024-02-29']");

    expect(grid).not.toBeNull();
    expect(Array.from(grid!.children).filter((child) => child.getAttribute("role") === "row").length).toBeGreaterThan(1);
    expect(currentDay?.getAttribute("role")).toBeNull();
    expect(currentDay?.parentElement?.getAttribute("role")).toBe("gridcell");
    expect(currentDay?.tabIndex).toBe(0);

    currentDay!.focus();
    currentDay!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();

    expect(document.activeElement).toBe(nextDay);
    expect(nextDay?.parentElement?.getAttribute("aria-selected")).toBe("true");

    nextDay!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();

    const nextWeek = document.querySelector<HTMLButtonElement>("[data-date-time-picker-day='2024-03-07']");
    expect(document.activeElement).toBe(nextWeek);
    expect(nextWeek?.parentElement?.getAttribute("aria-selected")).toBe("true");
  });

  it("cancels its draft on a dialog-internal outside click without closing the dialog", async () => {
    const { update } = mountPickerInDialog();
    await nextTick();

    document.querySelector<HTMLButtonElement>("[data-date-time-picker-trigger]")!.click();
    await waitForPopover();

    const input = document.querySelector<HTMLInputElement>("[data-date-time-picker-input]")!;
    input.value = "2024-03-01 11:12:13";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(input.value).toBe("2024-03-01 11:12:13");

    const dialogAction = document.querySelector<HTMLButtonElement>("[data-dialog-outside]")!;
    dialogAction.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    dialogAction.click();
    await waitForPopover();

    expect(update).not.toHaveBeenCalled();
    expect(document.querySelector("[data-slot='dialog-content']")).not.toBeNull();
    expect(document.querySelector("[data-date-time-picker-content]")).toBeNull();

    document.querySelector<HTMLButtonElement>("[data-date-time-picker-trigger]")!.click();
    await waitForPopover();
    expect(document.querySelector<HTMLInputElement>("[data-date-time-picker-input]")?.value).toBe("2024-02-28 08:09:10");
  });
});
