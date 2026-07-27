// @vitest-environment happy-dom

import { CalendarDateTime } from "@internationalized/date";
import { nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import { dispatch, findOne, hostText, mountComponent } from "@/components/grid/__tests__/vueHostHarness";

vi.mock("vue-i18n", async () => {
  const { ref } = await import("vue");
  return {
    useI18n: () => ({ locale: ref("en"), t: (key: string) => key }),
  };
});

vi.mock("@lucide/vue", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const icon = createPassthroughStub("Icon", "i");
  return { CalendarClock: icon, ChevronLeft: icon, ChevronRight: icon };
});

vi.mock("@/components/ui/button", async () => ({ Button: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Button", "button") }));

vi.mock("@/components/ui/popover", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  return {
    Popover: createPassthroughStub("Popover"),
    PopoverContent: createPassthroughStub("PopoverContent"),
    PopoverTrigger: createPassthroughStub("PopoverTrigger"),
  };
});

import DateTimePicker from "./DateTimePicker.vue";

function picker(options: Record<string, unknown> = {}) {
  return mountComponent(DateTimePicker, {
    open: true,
    modelValue: new CalendarDateTime(2024, 2, 28, 8, 9, 10),
    ...options,
  });
}

function inputFor(mounted: ReturnType<typeof picker>) {
  return findOne(mounted.root, (node) => node.props["data-date-time-picker-input"] !== undefined);
}

function buttonWithText(mounted: ReturnType<typeof picker>, text: string) {
  return findOne(mounted.root, (node) => node.type === "button" && hostText(node).trim() === text);
}

describe("DateTimePicker", () => {
  it("keeps typed and calendar changes in the draft until Apply", async () => {
    const update = vi.fn();
    const mounted = picker({ "onUpdate:modelValue": update });

    dispatch(inputFor(mounted), "input", { target: { value: "2024-02-29 11:12:13" } });
    await nextTick();
    expect(update).not.toHaveBeenCalled();

    dispatch(
      findOne(mounted.root, (node) => node.props["data-date-time-picker-day"] === "2024-02-29"),
      "click",
    );
    dispatch(buttonWithText(mounted, "Apply"), "click");

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({ year: 2024, month: 2, day: 29, hour: 11, minute: 12, second: 13 });
  });

  it("updates second-level time segments without committing early", async () => {
    const update = vi.fn();
    const mounted = picker({ "onUpdate:modelValue": update });
    const hour = findOne(mounted.root, (node) => node.props["data-date-time-picker-time-part"] === "hour");

    dispatch(hour, "input", { target: { value: "7" } });
    await nextTick();
    expect(update).not.toHaveBeenCalled();

    dispatch(hour, "keydown", { key: "Enter" });
    expect(update).not.toHaveBeenCalled();

    dispatch(buttonWithText(mounted, "Apply"), "click");
    expect(update.mock.calls[0][0]).toMatchObject({ hour: 7, minute: 9, second: 10 });
  });

  it("discards the draft on Cancel, Escape, and popover outside-close", async () => {
    const cancel = vi.fn();
    const mounted = picker({ onCancel: cancel });

    dispatch(inputFor(mounted), "input", { target: { value: "2024-03-01 11:12:13" } });
    dispatch(buttonWithText(mounted, "Cancel"), "click");
    await nextTick();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(inputFor(mounted).props.value).toBe("2024-02-28 08:09:10");

    dispatch(inputFor(mounted), "keydown", { key: "Escape" });
    expect(cancel).toHaveBeenCalledTimes(2);
    await nextTick();

    const popover = findOne(mounted.root, (node) => node.props["data-stub"] === "Popover");
    popover.props["onUpdate:open"](false);
    expect(cancel).toHaveBeenCalledTimes(3);
  });

  it("prevents invalid and disabled picker drafts from applying", async () => {
    const update = vi.fn();
    const mounted = picker({ min: new CalendarDateTime(2024, 3, 1, 0, 0, 0), "onUpdate:modelValue": update });

    expect(buttonWithText(mounted, "Apply").props.disabled).toBe(true);
    dispatch(buttonWithText(mounted, "Apply"), "click");
    expect(update).not.toHaveBeenCalled();

    await mounted.setProps({ disabled: true });
    expect(buttonWithText(mounted, "Apply").props.disabled).toBe(true);
  });

  it("leaves popover autofocus enabled for keyboard access to teleported content", () => {
    const mounted = picker();
    const content = findOne(mounted.root, (node) => node.props["data-stub"] === "PopoverContent");

    expect(content.props.onOpenAutoFocus).toBeUndefined();
    expect(content.props.onCloseAutoFocus).toBeUndefined();
  });

  it("keeps the popover within the available viewport height", () => {
    const mounted = picker();
    const content = findOne(mounted.root, (node) => node.props["data-stub"] === "PopoverContent");

    expect(content.props["collision-padding"] ?? content.props.collisionPadding).toBe(8);
    expect(content.props.class).toContain("max-h-[var(--reka-popover-content-available-height)]");
    expect(content.props.class).toContain("overflow-y-auto");
    expect(content.props.class).toContain("max-w-[calc(100vw-1rem)]");
  });

  it("can fill the available width when used as a form control", () => {
    const mounted = picker({ fullWidth: true });
    const control = findOne(mounted.root, (node) => node.props["data-date-time-picker"] !== undefined);
    const trigger = findOne(mounted.root, (node) => node.props["data-date-time-picker-trigger"] !== undefined);

    expect(control.props.class).toContain("w-full");
    expect(trigger.props.class).toContain("w-full");
  });

  it("keeps selectable adjacent-month dates at muted semantic contrast", () => {
    const mounted = picker();
    const adjacentDay = findOne(mounted.root, (node) => node.props["data-date-time-picker-day"] === "2024-01-28");

    expect(adjacentDay.props.class).toContain("text-muted-foreground");
    expect(adjacentDay.props.class).not.toContain("text-muted-foreground/60");
  });
});
