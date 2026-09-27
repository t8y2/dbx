// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { dispatch, findAll, findOne, hostText, mountComponent, type HostNode } from "./vueHostHarness";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@lucide/vue", async () => {
  const { createPassthroughStub } = await import("./vueHostHarness");
  const icon = createPassthroughStub("Icon", "i");
  return { Loader2: icon, Square: icon };
});
vi.mock("@/components/ui/button", async () => ({ Button: (await import("./vueHostHarness")).createPassthroughStub("Button", "button") }));

import DataGridBusyOverlay from "@/components/grid/DataGridBusyOverlay.vue";

const findCancelButton = (root: HostNode) => findAll(root, (node) => node.props["data-stub"] === "Button");

describe("DataGridBusyOverlay", () => {
  it("shows the elapsed seconds without a stop action by default", () => {
    const mounted = mountComponent(DataGridBusyOverlay, { elapsedMs: 12_340 });

    expect(hostText(mounted.root)).toContain("12.34s");
    expect(findCancelButton(mounted.root)).toHaveLength(0);
  });

  it("formats long waits and guards non-finite elapsed values", async () => {
    const mounted = mountComponent(DataGridBusyOverlay, { elapsedMs: 312_450 });
    expect(hostText(mounted.root)).toContain("312.45s");

    await mounted.setProps({ elapsedMs: Number.NaN });
    expect(hostText(mounted.root)).toContain("0.00s");
  });

  it("stops the running load from the elapsed pill", () => {
    const cancel = vi.fn();
    const mounted = mountComponent(DataGridBusyOverlay, { elapsedMs: 1_000, showCancel: true, onCancel: cancel });
    const button = findCancelButton(mounted.root)[0];

    expect(hostText(button)).toContain("toolbar.stopQuery");
    expect(button.props.disabled).toBe(false);

    dispatch(button, "click");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("switches to the cancelling state and blocks repeat clicks", () => {
    const cancel = vi.fn();
    const mounted = mountComponent(DataGridBusyOverlay, { elapsedMs: 900, showCancel: true, cancelling: true, onCancel: cancel });
    const button = findCancelButton(mounted.root)[0];

    expect(hostText(button)).toContain("common.stopping");
    expect(button.props.disabled).toBe(true);

    dispatch(button, "click");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("honours an explicit cancel-disabled state", () => {
    const mounted = mountComponent(DataGridBusyOverlay, { elapsedMs: 900, showCancel: true, cancelDisabled: true });

    expect(findCancelButton(mounted.root)[0].props.disabled).toBe(true);
  });

  it("keeps the page-jump card, its progress bar, and the stop action together", () => {
    const mounted = mountComponent(DataGridBusyOverlay, {
      elapsedMs: 45_000,
      showCancel: true,
      pageJumpProgress: { completedRequests: 3, totalRequests: 12, targetPage: 40 },
    });

    expect(hostText(mounted.root)).toContain("grid.pageJumpLoading");
    expect(hostText(mounted.root)).toContain("grid.pageJumpProgress");
    expect(hostText(mounted.root)).toContain("45.00s");
    const progressbar = findOne(mounted.root, (node) => node.props.role === "progressbar");
    expect(progressbar.props["aria-valuenow"]).toBe(3);
    expect(progressbar.props["aria-valuemax"]).toBe(12);
    expect(findCancelButton(mounted.root)).toHaveLength(1);
  });

  it("hides the stop action on the page-jump card for callers that cannot cancel", () => {
    const mounted = mountComponent(DataGridBusyOverlay, {
      elapsedMs: 45_000,
      pageJumpProgress: { completedRequests: 1, totalRequests: 9, targetPage: 3 },
    });

    expect(findCancelButton(mounted.root)).toHaveLength(0);
  });
});
