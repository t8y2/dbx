// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToast } from "@/composables/useToast";

describe("toast lifetime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const state = useToast();
    state.dismissToast();
    for (const message of state.persistentMessages?.value ?? []) state.dismissToast(message.id);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps an operation error after both its old timeout and a subsequent success notification", () => {
    const state = useToast();
    state.toast("Operation failed: foreign key dependency", { persistent: true });
    state.toast("Copied");

    vi.advanceTimersByTime(30_000);

    expect(state.visible.value).toBe(false);
    expect(state.persistentMessages?.value.map((entry) => entry.message)).toEqual(["Operation failed: foreign key dependency"]);
  });

  it("dismisses only the selected error, preserving other errors and their actions", () => {
    const state = useToast();
    const action = { label: "View details", onClick: vi.fn() };
    state.toast("First failure", { persistent: true });
    state.toast("Second failure", { persistent: true }, action);

    expect(state.persistentMessages?.value).toHaveLength(2);
    const [first, second] = state.persistentMessages.value;
    state.dismissToast(first.id);
    vi.advanceTimersByTime(30_000);

    expect(state.persistentMessages.value).toEqual([second]);
    state.persistentMessages.value[0].action?.onClick();
    expect(action.onClick).toHaveBeenCalledOnce();
    state.dismissToast(second.id);
    expect(state.persistentMessages.value).toEqual([]);
  });

  it("does not let a previously scheduled transient timeout dismiss an error", () => {
    const state = useToast();
    state.toast("Working", 5000);
    vi.advanceTimersByTime(4000);
    state.toast("Failed", { persistent: true });
    vi.advanceTimersByTime(1000);

    expect(state.visible.value).toBe(false);
    expect(state.persistentMessages?.value.map((entry) => entry.message)).toEqual(["Failed"]);
  });

  it("keeps the latest transient message for its requested duration", () => {
    const state = useToast();
    state.toast("First");
    vi.advanceTimersByTime(1000);
    state.toast("Second", 5000);
    vi.advanceTimersByTime(4999);
    expect(state.visible.value).toBe(true);
    expect(state.message.value).toBe("Second");
    vi.advanceTimersByTime(1);
    expect(state.visible.value).toBe(false);
  });

  it("keeps default transient notifications and manual dismissal compatible", () => {
    const state = useToast();
    state.toast("Copied");
    vi.advanceTimersByTime(1999);
    expect(state.visible.value).toBe(true);
    vi.advanceTimersByTime(1);
    expect(state.visible.value).toBe(false);

    state.toast("Saved", 5000, { label: "View", onClick: vi.fn() });
    state.dismissToast();
    expect(state.visible.value).toBe(false);
    expect(state.action.value).toBeUndefined();
  });
});
