import { describe, expect, it } from "vitest";
import { buildAnomalyDigest, buildSidebarLayoutReport, captureSidebarLayoutSample, detectLayoutAnomalies, ringPush, unreachableRowCount, type SidebarLayoutMonitorContext, type SidebarLayoutSample } from "@/lib/sidebar/sidebarLayoutMonitor";

function makeSample(overrides: Partial<SidebarLayoutSample> = {}): SidebarLayoutSample {
  const base: SidebarLayoutSample = {
    t: 1000,
    windowHeight: 900,
    rootHeight: 860,
    shellHeight: 800,
    shellRatioOfRoot: 800 / 860,
    shellRatioOfWindow: 800 / 900,
    flatNodeCount: 60,
    scroller: { clientHeight: 800, scrollHeight: 1680, scrollTop: 0, computedHeight: "800px", overflowY: "auto", position: "relative" },
    virtual: { itemSize: 28, expectedScrollHeight: 1680, renderedRows: 32, visiblePoolSize: 32, spacers: { start: 0, end: 0 }, scrollWindow: { start: 0, end: 800 }, listHeight: 1680 },
    rows: { renderedRows: 32, firstTop: 0, firstBottom: 28, lastTop: 868, lastBottom: 896 },
    sticky: null,
  };
  return {
    ...base,
    ...overrides,
    scroller: { ...base.scroller, ...overrides.scroller },
    virtual: overrides.virtual !== undefined ? overrides.virtual : base.virtual,
    rows: overrides.rows !== undefined ? overrides.rows : base.rows,
  };
}

function samples(count: number, sample: SidebarLayoutSample): SidebarLayoutSample[] {
  return Array.from({ length: count }, (_, index) => ({ ...sample, t: sample.t + index }));
}

describe("ringPush", () => {
  it("appends entries and caps the ring at maxSize", () => {
    expect(ringPush(["a", "b"], "c", 3)).toEqual(["a", "b", "c"]);
    expect(ringPush(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
    expect(ringPush([], "a", 3)).toEqual(["a"]);
  });

  it("never mutates the source ring", () => {
    const source = ["a", "b"];
    ringPush(source, "c", 3);
    expect(source).toEqual(["a", "b"]);
  });
});

describe("captureSidebarLayoutSample", () => {
  it("falls back to a zeroed sample without DOM but keeps the tree context", () => {
    const sample = captureSidebarLayoutSample({ flatNodeCount: 42 } as SidebarLayoutMonitorContext);
    expect(sample.flatNodeCount).toBe(42);
    expect(sample.windowHeight).toBe(0);
    expect(sample.shellHeight).toBe(0);
    expect(sample.virtual).toBeNull();
    expect(sample.rows).toBeNull();
  });
});

describe("unreachableRowCount", () => {
  it("counts rows that can never enter the scrollable viewport", () => {
    const healthy = makeSample();
    expect(unreachableRowCount(healthy)).toBe(0);

    const truncated = makeSample({ scroller: { scrollHeight: 840 } });
    expect(unreachableRowCount(truncated)).toBe(60 - Math.floor(840 / 28));
  });

  it("returns zero for the plain (non-virtual) tree", () => {
    const plain = makeSample({ virtual: null });
    expect(unreachableRowCount(plain)).toBe(0);
  });
});

describe("detectLayoutAnomalies", () => {
  it("reports nothing for a stable healthy tree", () => {
    expect(detectLayoutAnomalies(samples(6, makeSample()))).toEqual([]);
  });

  it("flags the shell stuck near half the window height after 3 consecutive samples", () => {
    const halfShell = makeSample({ windowHeight: 900, rootHeight: 860, shellHeight: 450, shellRatioOfRoot: 450 / 860, shellRatioOfWindow: 450 / 900, scroller: { clientHeight: 450 } });
    expect(detectLayoutAnomalies(samples(2, halfShell))).toEqual([]);
    expect(detectLayoutAnomalies(samples(4, halfShell))).toEqual(["half-height-shell"]);
  });

  it("flags under-scroll when scrollHeight falls far below expected itemSize x count", () => {
    const truncated = makeSample({ scroller: { scrollHeight: 840 } });
    expect(detectLayoutAnomalies(samples(3, truncated))).toContain("under-scroll");
  });

  it("flags bottom rows as unreachable only when scrolled to the bottom", () => {
    const truncated = makeSample({ scroller: { scrollHeight: 840, clientHeight: 450, scrollTop: 100 } });
    expect(detectLayoutAnomalies(samples(3, truncated))).not.toContain("bottom-unreachable");

    const atBottom = makeSample({ scroller: { scrollHeight: 840, clientHeight: 450, scrollTop: 390 } });
    const flags = detectLayoutAnomalies(samples(3, atBottom));
    expect(flags).toContain("under-scroll");
    expect(flags).toContain("bottom-unreachable");
  });

  it("flags plain-tree rows clipped beyond scrollHeight", () => {
    const plain = makeSample({ virtual: null, rows: { renderedRows: 60, firstTop: 0, firstBottom: 28, lastTop: 1800, lastBottom: 1900 } });
    expect(detectLayoutAnomalies(samples(3, plain))).toEqual(["rows-clipped"]);
  });

  it("flags a blank gap between the rendered pool and the viewport bottom", () => {
    const blank = makeSample({
      rows: { renderedRows: 12, firstTop: 0, firstBottom: 28, lastTop: 300, lastBottom: 500 },
      scroller: { scrollTop: 100, clientHeight: 800 },
    });
    expect(detectLayoutAnomalies(samples(3, blank))).toContain("blank-viewport");
  });
});

describe("buildSidebarLayoutReport", () => {
  const context: SidebarLayoutMonitorContext = {
    flatNodeCount: 60,
    useVirtualTree: true,
    virtualItemSize: 28,
    scrollerEl: null,
    shellEl: null,
    rootEl: null,
    virtualScroller: null,
    expandedConnections: [{ id: "conn-dm-1", label: "达梦测试库", type: "connection", descendantCount: 132 }],
  };

  it("builds a digest that describes geometry, flags and expanded connections without a DOM", () => {
    const truncated = makeSample({ scroller: { scrollHeight: 840, scrollTop: 390 } });
    const report = buildSidebarLayoutReport(truncated, { sampleHistory: samples(6, makeSample()).concat([truncated]), events: [], context, flags: ["under-scroll", "bottom-unreachable"] });

    expect(report.ancestors).toEqual([]);
    expect(report.content).toBeNull();
    expect(report.expandedConnections).toHaveLength(1);
    expect(report.sampleHistory.length).toBe(7);

    const digest = buildAnomalyDigest(report);
    expect(digest).toContain("anomaly detected");
    expect(digest).toContain("under-scroll");
    expect(digest).toContain("达梦测试库");
    expect(digest).toContain("expected 1680px");
    expect(digest).toContain("actual 840px");
    expect(report.digest).toBe(digest);
  });

  it("keeps an empty sample ring from breaking the report", () => {
    const sample = makeSample();
    const report = buildSidebarLayoutReport(sample, { sampleHistory: [sample], events: [], context, flags: [] });
    expect(report.transition).toBeNull();
    expect(report.digest).toContain("anomaly detected (sidebar-layout-");
    expect(report.digest).toContain("none");
  });

  it("trims embedded history and events so snapshots stay copy-paste sized", () => {
    const truncated = makeSample({ scroller: { scrollHeight: 840, scrollTop: 390 } });
    const history = samples(200, makeSample()).concat([truncated]);
    const events = Array.from({ length: 200 }, (_, index) => ({ type: "tree-change" as const, t: 1000 + index, prevCount: index, count: index + 1, expandedConnections: [] }));
    const report = buildSidebarLayoutReport(truncated, { sampleHistory: history, events, context, flags: [] });
    expect(report.sampleHistory).toHaveLength(60);
    expect(report.events).toHaveLength(60);
  });

  it("describes the maximum scroll offset in the digest", () => {
    const truncated = makeSample({ scroller: { scrollHeight: 840, clientHeight: 450, scrollTop: 390 } });
    const report = buildSidebarLayoutReport(truncated, { sampleHistory: [truncated], events: [], context, flags: ["under-scroll"] });
    expect(report.digest).toContain("max-scroll=390");
  });
});
