// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import DataGridAutoRefreshClock from "@/components/grid/DataGridAutoRefreshClock.vue";
import { findOne, mountComponent, type HostNode } from "./vueHostHarness";

const clockPath = "apps/desktop/src/components/grid/DataGridAutoRefreshClock.vue";
const source = readFileSync(clockPath, "utf8");

function findHand(node: HostNode): HostNode {
  return findOne(node, (candidate) => candidate.type === "line" && candidate.props["data-auto-refresh-hand"] !== undefined);
}

describe("DataGridAutoRefreshClock", () => {
  it("keeps the stopwatch body and draws the hand from the centre", () => {
    const host = mountComponent(DataGridAutoRefreshClock, { enabled: false });

    expect(findOne(host.root, (node) => node.type === "svg").props["aria-hidden"]).toBe("true");
    expect(findOne(host.root, (node) => node.type === "circle").props).toMatchObject({ cx: "12", cy: "14", r: "8" });

    const hand = findHand(host.root);
    expect(hand.props).toMatchObject({ x1: "12", y1: "14", x2: "12", y2: "8" });
    host.unmount();
  });

  it("sweeps one full turn per interval while enabled", () => {
    const host = mountComponent(DataGridAutoRefreshClock, { enabled: true, intervalSeconds: 30, sweepKey: 1 });

    const hand = findHand(host.root);
    expect(hand.props.class).toContain("data-grid-auto-refresh-hand--sweeping");
    expect(hand.props.style["--dbx-auto-refresh-sweep-duration"]).toBe("30s");
    expect(hand.props.style["transform-origin"]).toBeUndefined();
    host.unmount();
  });

  it("parks the hand while auto-refresh is off", () => {
    const host = mountComponent(DataGridAutoRefreshClock, { enabled: false, intervalSeconds: 5, sweepKey: 4 });

    expect(findHand(host.root).props.class ?? "").not.toContain("--sweeping");
    host.unmount();
  });

  it("re-creates the hand when the sweep key changes so the turn restarts", async () => {
    const host = mountComponent(DataGridAutoRefreshClock, { enabled: true, intervalSeconds: 10, sweepKey: 1 });
    const first = findHand(host.root);

    await host.setProps({ sweepKey: 2 });

    expect(findHand(host.root)).not.toBe(first);
    host.unmount();
  });

  it("falls back to a ten second turn for missing or unusable intervals", () => {
    for (const intervalSeconds of [undefined, Number.NaN, 0, -5]) {
      const host = mountComponent(DataGridAutoRefreshClock, { enabled: true, intervalSeconds });
      expect(findHand(host.root).props.style["--dbx-auto-refresh-sweep-duration"]).toBe("10s");
      host.unmount();
    }
  });

  it("rotates about the clock centre and opts out of motion on request", () => {
    expect(source).toContain("transform-box: view-box");
    expect(source).toContain("transform-origin: 12px 14px");
    expect(source).toContain("animation: data-grid-auto-refresh-sweep var(--dbx-auto-refresh-sweep-duration, 10s) linear");
    // House spinner idiom: the motion is cosmetic information, so honour the
    // system preference rather than animating unconditionally.
    expect(source).toContain("@media (prefers-reduced-motion: reduce)");
    expect(source).toContain("animation: none");
  });
});
