// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  clampFloatingSize,
  defaultFloatingPosition,
  dockRectsForEdge,
  FLOATING_EDGE_MARGIN_PX,
  FLOATING_MAX_HEIGHT_PX,
  FLOATING_MAX_WIDTH_PX,
  FLOATING_MIN_HEIGHT_PX,
  FLOATING_MIN_WIDTH_PX,
  FLOATING_SNAP_THRESHOLD_PX,
  parseFloatingPosition,
  parseFloatingWindowRequest,
  pickMonitorForPoint,
  pointInsideWorkArea,
  resolveFloatingPlacement,
  snapRectToWorkArea,
  type FloatingMonitor,
} from "@/lib/plugins/pluginFloatingWindow";
import { MAX_PLUGIN_WINDOW_CONTEXT_BYTES, decodeFloatingPluginContext, encodeFloatingPluginContext, floatingWindowLabel, floatingWindowUrl, isFloatingWindowLabel } from "@/lib/app/windowContext";

/** A 1920x1080 monitor whose taskbar takes the bottom 40px, at 1x DPI. */
const monitor: FloatingMonitor = { x: 0, y: 0, width: 1920, height: 1040, scaleFactor: 1 };
/** A second monitor to the right, at 2x DPI, with its own taskbar. */
const hidpiMonitor: FloatingMonitor = { x: 1920, y: 0, width: 3840, height: 2080, scaleFactor: 2 };

describe("snapRectToWorkArea", () => {
  it("pulls a window onto an edge it landed near and reports that edge", () => {
    const result = snapRectToWorkArea({ x: 12, y: 500, width: 260, height: 60 }, monitor, { margin: FLOATING_EDGE_MARGIN_PX, threshold: FLOATING_SNAP_THRESHOLD_PX });
    expect(result.rect.x).toBe(FLOATING_EDGE_MARGIN_PX);
    expect(result.rect.y).toBe(500);
    expect(result.edges).toEqual(["left"]);
  });

  it("snaps both axes in a corner", () => {
    const result = snapRectToWorkArea({ x: 1660, y: 980, width: 260, height: 60 }, monitor, { margin: FLOATING_EDGE_MARGIN_PX, threshold: 80 });
    expect(result.rect).toEqual({ x: 1920 - FLOATING_EDGE_MARGIN_PX - 260, y: 1040 - FLOATING_EDGE_MARGIN_PX - 60, width: 260, height: 60 });
    expect(result.edges).toEqual(["right", "bottom"]);
  });

  it("leaves a window in the middle of the work area where the user dropped it", () => {
    const result = snapRectToWorkArea({ x: 800, y: 400, width: 260, height: 60 }, monitor, { margin: FLOATING_EDGE_MARGIN_PX, threshold: FLOATING_SNAP_THRESHOLD_PX });
    expect(result.rect).toEqual({ x: 800, y: 400, width: 260, height: 60 });
    expect(result.edges).toEqual([]);
  });

  it("snaps a window shoved past an edge onto that edge, so it is never lost off-screen", () => {
    // A drag tracks the native cursor with no lower bound, so pushing the widget
    // against a border lands the release well outside the threshold band. That
    // overshoot is the intent to dock, and the result is still fully on screen.
    const result = snapRectToWorkArea({ x: 2400, y: -300, width: 260, height: 60 }, monitor, { margin: FLOATING_EDGE_MARGIN_PX, threshold: FLOATING_SNAP_THRESHOLD_PX });
    expect(result.edges).toEqual(["right", "top"]);
    expect(result.rect).toEqual({ x: 1920 - FLOATING_EDGE_MARGIN_PX - 260, y: FLOATING_EDGE_MARGIN_PX, width: 260, height: 60 });
  });

  it("snaps anywhere along an edge, not only where the threshold band reaches", () => {
    const shovedLeft = snapRectToWorkArea({ x: -140, y: 500, width: 260, height: 60 }, monitor, { margin: FLOATING_EDGE_MARGIN_PX, threshold: FLOATING_SNAP_THRESHOLD_PX });
    expect(shovedLeft.edges).toEqual(["left"]);
    expect(shovedLeft.rect.x).toBe(FLOATING_EDGE_MARGIN_PX);
    expect(shovedLeft.rect.y).toBe(500);

    const shovedBottom = snapRectToWorkArea({ x: 800, y: 1200, width: 260, height: 60 }, monitor, { margin: FLOATING_EDGE_MARGIN_PX, threshold: FLOATING_SNAP_THRESHOLD_PX });
    expect(shovedBottom.edges).toEqual(["bottom"]);
    expect(shovedBottom.rect.y).toBe(1040 - FLOATING_EDGE_MARGIN_PX - 60);
    expect(shovedBottom.rect.x).toBe(800);
  });

  it("scales the margin and threshold by the monitor DPI, so a snap feels the same on every display", () => {
    // 40 physical px from the edge is inside the 28 logical px threshold on a 2x
    // monitor (56 physical px), so it snaps onto the 16 logical px (32 physical) margin.
    const hidpi = snapRectToWorkArea({ x: 1920 + 32 + 40, y: 500, width: 520, height: 120 }, hidpiMonitor, { margin: FLOATING_EDGE_MARGIN_PX, threshold: FLOATING_SNAP_THRESHOLD_PX });
    expect(hidpi.rect.x).toBe(1920 + FLOATING_EDGE_MARGIN_PX * 2);
    expect(hidpi.edges).toEqual(["left"]);

    // The same 40 physical px on a 1x monitor is outside the threshold and stays put.
    const standard = snapRectToWorkArea({ x: FLOATING_EDGE_MARGIN_PX + 40, y: 500, width: 260, height: 60 }, monitor, { margin: FLOATING_EDGE_MARGIN_PX, threshold: FLOATING_SNAP_THRESHOLD_PX });
    expect(standard.rect.x).toBe(FLOATING_EDGE_MARGIN_PX + 40);
    expect(standard.edges).toEqual([]);
  });

  it("keeps a window larger than the work area reachable instead of snapping it", () => {
    const result = snapRectToWorkArea({ x: -500, y: 500, width: 4000, height: 60 }, monitor, { margin: FLOATING_EDGE_MARGIN_PX, threshold: FLOATING_SNAP_THRESHOLD_PX });
    // No edge is meaningful when the window is wider than the work area, so the
    // inverted range only has to keep part of it on screen — the drop position stands.
    expect(result.edges).toEqual([]);
    expect(result.rect.x).toBe(-500);
    expect(result.rect.x).toBeGreaterThanOrEqual(1920 - FLOATING_EDGE_MARGIN_PX - 4000);
    expect(result.rect.x).toBeLessThanOrEqual(FLOATING_EDGE_MARGIN_PX);
  });
});

describe("dockRectsForEdge", () => {
  const rect = { x: 1600, y: 500, width: 260, height: 60 };

  it("tucks a right-docked widget off-screen leaving exactly the sliver", () => {
    const dock = dockRectsForEdge(rect, monitor, "right", 14);
    expect(dock.revealed).toEqual({ x: 1920 - 260, y: 500 });
    expect(dock.tucked).toEqual({ x: 1920 - 14, y: 500 });
    expect(dock.sliver).toEqual({ x: 1920 - 14, y: 500, width: 14, height: 60 });
  });

  it("tucks a left-docked widget the other way, sliver flush to the edge", () => {
    const dock = dockRectsForEdge(rect, monitor, "left", 14);
    expect(dock.revealed).toEqual({ x: 0, y: 500 });
    expect(dock.tucked).toEqual({ x: 14 - 260, y: 500 });
    expect(dock.sliver).toEqual({ x: 0, y: 500, width: 14, height: 60 });
  });

  it("tucks a bottom-docked widget vertically", () => {
    const dock = dockRectsForEdge(rect, monitor, "bottom", 14);
    expect(dock.revealed).toEqual({ x: 1600, y: 1040 - 60 });
    expect(dock.tucked).toEqual({ x: 1600, y: 1040 - 14 });
    expect(dock.sliver).toEqual({ x: 1600, y: 1040 - 14, width: 260, height: 14 });
  });

  it("scales the sliver by the monitor DPI", () => {
    const hidpiRect = { x: 2200, y: 500, width: 520, height: 120 };
    const dock = dockRectsForEdge(hidpiRect, hidpiMonitor, "right", 14);
    expect(dock.revealed).toEqual({ x: 1920 + 3840 - 520, y: 500 });
    expect(dock.tucked).toEqual({ x: 1920 + 3840 - 28, y: 500 });
    expect(dock.sliver.width).toBe(28);
  });
});

describe("resolveFloatingPlacement with a docked position", () => {
  it("restores a docked home like any on-screen point (it stores the revealed position)", () => {
    // Right-docked and revealed: flush to the edge, fully on screen.
    const placement = resolveFloatingPlacement({ x: 1920 - 260, y: 500, scaleFactor: 1, edge: "right" }, [monitor], { width: 260, height: 60 });
    expect(placement).toEqual({ x: 1920 - 260, y: 500, restored: true });
  });

  it("falls back to the default when a docked home lost its monitor", () => {
    const placement = resolveFloatingPlacement({ x: 1920 - 260, y: 500, scaleFactor: 1, edge: "right" }, [hidpiMonitor], { width: 260, height: 60 });
    expect(placement.restored).toBe(false);
    expect(placement.x).toBeGreaterThan(hidpiMonitor.x);
  });

  it("keeps the dock edge through the storage round-trip", () => {
    expect(parseFloatingPosition(JSON.stringify({ x: 1, y: 2, scaleFactor: 1.5, edge: "bottom" }))).toEqual({ x: 1, y: 2, scaleFactor: 1.5, edge: "bottom" });
    expect(parseFloatingPosition(JSON.stringify({ x: 1, y: 2, scaleFactor: 1, edge: "diagonal" }))).toEqual({ x: 1, y: 2, scaleFactor: 1 });
  });
});

describe("monitor lookup", () => {
  it("picks the monitor that contains the point and falls back to the first one", () => {
    expect(pointInsideWorkArea({ x: 2000, y: 100 }, hidpiMonitor)).toBe(true);
    expect(pickMonitorForPoint({ x: 2000, y: 100 }, [monitor, hidpiMonitor])).toBe(hidpiMonitor);
    expect(pickMonitorForPoint({ x: 100, y: 100 }, [monitor, hidpiMonitor])).toBe(monitor);
    // A point on no monitor (display unplugged between reads) still gets a target.
    expect(pickMonitorForPoint({ x: -9000, y: -9000 }, [monitor, hidpiMonitor])).toBe(monitor);
    expect(pickMonitorForPoint({ x: 0, y: 0 }, [])).toBeNull();
  });
});

describe("clampFloatingSize", () => {
  it("clamps into the floating bounds and falls back to the minimum for garbage", () => {
    expect(clampFloatingSize(260, 60)).toEqual({ width: 260, height: 60 });
    expect(clampFloatingSize(10, 4)).toEqual({ width: FLOATING_MIN_WIDTH_PX, height: FLOATING_MIN_HEIGHT_PX });
    expect(clampFloatingSize(99_999, 99_999)).toEqual({ width: FLOATING_MAX_WIDTH_PX, height: FLOATING_MAX_HEIGHT_PX });
    expect(clampFloatingSize(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ width: FLOATING_MIN_WIDTH_PX, height: FLOATING_MIN_HEIGHT_PX });
    expect(clampFloatingSize(260.6, 60.4)).toEqual({ width: 261, height: 60 });
  });
});

describe("defaultFloatingPosition", () => {
  it("lands in the bottom-right corner of the work area, clear of the edge", () => {
    expect(defaultFloatingPosition(monitor, { width: 260, height: 60 }, FLOATING_EDGE_MARGIN_PX)).toEqual({ x: 1920 - FLOATING_EDGE_MARGIN_PX - 260, y: 1040 - FLOATING_EDGE_MARGIN_PX - 60 });
  });

  it("scales the logical size and margin for a HiDPI monitor", () => {
    expect(defaultFloatingPosition(hidpiMonitor, { width: 260, height: 60 }, FLOATING_EDGE_MARGIN_PX)).toEqual({ x: 1920 + 3840 - 32 - 520, y: 2080 - 32 - 120 });
  });

  it("never pushes the window off the top-left of a work area smaller than the window", () => {
    const tiny: FloatingMonitor = { x: 100, y: 100, width: 120, height: 80, scaleFactor: 1 };
    expect(defaultFloatingPosition(tiny, { width: 260, height: 60 }, FLOATING_EDGE_MARGIN_PX)).toEqual({ x: 116, y: 116 });
  });
});

describe("resolveFloatingPlacement", () => {
  const size = { width: 260, height: 60 };

  it("restores the stored position when it still lands on a connected monitor", () => {
    const placement = resolveFloatingPlacement({ x: 400, y: 300, scaleFactor: 1 }, [monitor], size);
    expect(placement).toEqual({ x: 400, y: 300, restored: true });
  });

  it("pulls a stored position that hangs over the edge back inside the work area", () => {
    // The taskbar grew since the position was stored: the point now sits in it.
    // Restore clamps the point a margin away from every edge — the window's real
    // size is not known yet, so it must not be part of the math.
    const placement = resolveFloatingPlacement({ x: 1915, y: 1035, scaleFactor: 1 }, [monitor], size);
    expect(placement.restored).toBe(true);
    expect(placement.x).toBe(1920 - FLOATING_EDGE_MARGIN_PX);
    expect(placement.y).toBe(1040 - FLOATING_EDGE_MARGIN_PX);
  });

  it("falls back to the work-area default when the stored position is on a monitor that is gone", () => {
    const placement = resolveFloatingPlacement({ x: 5000, y: 3000, scaleFactor: 1 }, [monitor], size);
    expect(placement).toEqual({ ...defaultFloatingPosition(monitor, size, FLOATING_EDGE_MARGIN_PX), restored: false });
  });

  it("falls back to the origin when no monitor is known at all", () => {
    expect(resolveFloatingPlacement({ x: 400, y: 300, scaleFactor: 1 }, [], size)).toEqual({ x: 0, y: 0, restored: false });
  });

  it("opens on the monitor the caller is on, not just the first connected one", () => {
    const placement = resolveFloatingPlacement(null, [monitor, hidpiMonitor], size, hidpiMonitor);
    expect(placement.restored).toBe(false);
    expect(placement).toEqual({ ...defaultFloatingPosition(hidpiMonitor, size, FLOATING_EDGE_MARGIN_PX), restored: false });
  });
});

describe("parseFloatingPosition", () => {
  it("reads back what was persisted and rejects anything malformed", () => {
    expect(parseFloatingPosition(JSON.stringify({ x: 10, y: -20, scaleFactor: 2 }))).toEqual({ x: 10, y: -20, scaleFactor: 2 });
    // A missing or non-positive scale factor is normalized, not rejected: the
    // position itself is still usable.
    expect(parseFloatingPosition(JSON.stringify({ x: 10, y: 20 }))).toEqual({ x: 10, y: 20, scaleFactor: 1 });
    expect(parseFloatingPosition(JSON.stringify({ x: 10, y: 20, scaleFactor: 0 }))).toEqual({ x: 10, y: 20, scaleFactor: 1 });
    expect(parseFloatingPosition(null)).toBeNull();
    expect(parseFloatingPosition("")).toBeNull();
    expect(parseFloatingPosition("not json")).toBeNull();
    expect(parseFloatingPosition(JSON.stringify({ x: 10 }))).toBeNull();
    expect(parseFloatingPosition(JSON.stringify({ x: "10", y: 20 }))).toBeNull();
    expect(parseFloatingPosition(JSON.stringify({ x: Number.NaN, y: 20 }))).toBeNull();
  });
});

describe("parseFloatingWindowRequest", () => {
  it("keeps the host-supplied plugin id and passes through the declared options", () => {
    const request = parseFloatingWindowRequest("io.dbx.demo", {
      contributionId: "capsule",
      title: "  Now playing  ",
      width: 260,
      height: 60,
      alwaysOnTop: false,
      context: { queueId: "q1" },
      // A plugin cannot open a window for somebody else's plugin.
      pluginId: "io.dbx.other",
    });
    expect(request).toEqual({
      pluginId: "io.dbx.demo",
      contributionId: "capsule",
      title: "Now playing",
      width: 260,
      height: 60,
      alwaysOnTop: false,
      context: { queueId: "q1" },
    });
  });

  it("omits options the plugin did not send, so host defaults apply", () => {
    expect(parseFloatingWindowRequest("io.dbx.demo", { contributionId: "capsule" })).toEqual({ pluginId: "io.dbx.demo", contributionId: "capsule" });
    expect(parseFloatingWindowRequest("io.dbx.demo", { contributionId: "capsule", title: "   ", context: null })).toEqual({ pluginId: "io.dbx.demo", contributionId: "capsule" });
  });

  it("rejects malformed input instead of forwarding it to the window manager", () => {
    expect(() => parseFloatingWindowRequest("io.dbx.demo", {})).toThrow(/contributionId/);
    expect(() => parseFloatingWindowRequest("io.dbx.demo", { contributionId: "" })).toThrow(/contributionId/);
    expect(() => parseFloatingWindowRequest("io.dbx.demo", { contributionId: "../escape" })).toThrow(/contributionId/);
    expect(() => parseFloatingWindowRequest("io.dbx.demo", { contributionId: 42 as unknown as string })).toThrow(/contributionId/);
    expect(() => parseFloatingWindowRequest("io.dbx.demo", { contributionId: "capsule", width: "260" })).toThrow(/width/);
    expect(() => parseFloatingWindowRequest("io.dbx.demo", { contributionId: "capsule", height: Number.NaN })).toThrow(/height/);
    expect(() => parseFloatingWindowRequest("io.dbx.demo", { contributionId: "capsule", x: "10" })).toThrow(/x must be a finite number/);
    expect(() => parseFloatingWindowRequest("io.dbx.demo", { contributionId: "capsule", context: [1, 2] })).toThrow(/context/);
  });
});

describe("floating window identity", () => {
  it("derives a deterministic label per plugin and contribution, so reopening focuses the same window", () => {
    const label = floatingWindowLabel("io.dbx.demo", "capsule");
    expect(label).toBe(floatingWindowLabel("io.dbx.demo", "capsule"));
    expect(label.startsWith("plugin-floating-")).toBe(true);
    expect(isFloatingWindowLabel(label)).toBe(true);
    // Other window kinds must never be addressable through the floating path.
    expect(isFloatingWindowLabel("main")).toBe(false);
    expect(isFloatingWindowLabel("detached-tab-1234")).toBe(false);
  });

  it("keeps the label inside Tauri's charset (no dots) and inside the length bound", () => {
    // Tauri rejects window labels outside alphanumeric + - / : _ — plugin ids are
    // full of dots, so they must never reach the label verbatim.
    for (const label of [floatingWindowLabel("io.dbx.demo", "capsule"), floatingWindowLabel("io.dbx.demo", "cap sule/with symbols")]) {
      expect(label).toMatch(/^plugin-floating-[A-Za-z0-9_/-]+$/);
      expect(label).not.toMatch(/\./);
    }
    // Slugs that differ only in stripped characters stay apart through the hash:
    // "io.dbx.demo" and "io-dbx-demo" must not share a window.
    expect(floatingWindowLabel("io.dbx.demo", "capsule")).not.toBe(floatingWindowLabel("io-dbx-demo", "capsule"));
    const long = floatingWindowLabel("io.dbx.".concat("a".repeat(200)), "contribution");
    expect(long.startsWith("plugin-floating-")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long).toBe(floatingWindowLabel("io.dbx.".concat("a".repeat(200)), "contribution"));
    expect(long).not.toBe(floatingWindowLabel("io.dbx.".concat("a".repeat(200)), "other"));
  });

  it("carries the plugin identity and bounded context in the window url", () => {
    const url = new URL(floatingWindowUrl("io.dbx.demo", "capsule", { queueId: "q1" }));
    expect(url.searchParams.get("dbxPluginWindow")).toBe("io.dbx.demo");
    expect(url.searchParams.get("dbxPluginContribution")).toBe("capsule");
    expect(decodeFloatingPluginContext(url.searchParams.get("dbxPluginWindowContext") ?? undefined)).toEqual({ queueId: "q1" });
    expect(url.hash).toBe("");

    // No context: no parameter at all, so the url stays readable.
    expect(new URL(floatingWindowUrl("io.dbx.demo", "capsule")).searchParams.has("dbxPluginWindowContext")).toBe(false);
  });

  it("round-trips the context codec and drops payloads that do not fit", () => {
    expect(decodeFloatingPluginContext(encodeFloatingPluginContext({ a: 1, b: ["x", null], c: { d: true } }))).toEqual({ a: 1, b: ["x", null], c: { d: true } });
    // Non-ASCII survives the UTF-8 round trip.
    expect(decodeFloatingPluginContext(encodeFloatingPluginContext({ title: "夜曲 · Live" }))).toEqual({ title: "夜曲 · Live" });
    expect(encodeFloatingPluginContext(undefined)).toBeUndefined();
    expect(encodeFloatingPluginContext({})).toBeUndefined();
    expect(encodeFloatingPluginContext({ blob: "x".repeat(MAX_PLUGIN_WINDOW_CONTEXT_BYTES) })).toBeUndefined();
    expect(decodeFloatingPluginContext(undefined)).toBeUndefined();
    expect(decodeFloatingPluginContext("!!!not base64!!!")).toBeUndefined();
    // Valid base64url of a non-object is still not a context.
    expect(decodeFloatingPluginContext(encodeFloatingPluginContext({ a: 1 })?.replace(/./g, "e") ?? "")).toBeUndefined();
  });
});
