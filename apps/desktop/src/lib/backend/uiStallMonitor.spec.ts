// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { UI_STALL_CHECK_INTERVAL_MS, UI_STALL_IDLE_INTERVAL_MS, UI_STALL_SUSPEND_GAP_MS, UI_STALL_THRESHOLD_MS, createUiStallDetector, describeInputTarget, installUiStallMonitor, supportsLongTaskEntries, type UiStallReport } from "./uiStallMonitor";

describe("supportsLongTaskEntries", () => {
  it("is true only when the engine advertises the longtask entry type", () => {
    expect(supportsLongTaskEntries({ supportedEntryTypes: ["mark", "measure", "longtask"] })).toBe(true);
    // WKWebView on macOS 15.5 reports exactly these types and no longtask.
    expect(supportsLongTaskEntries({ supportedEntryTypes: ["mark", "measure", "navigation", "paint", "resource"] })).toBe(false);
    expect(supportsLongTaskEntries({})).toBe(false);
    expect(supportsLongTaskEntries(undefined)).toBe(false);
  });
});

describe("createUiStallDetector", () => {
  function setup(initialVisible = true) {
    const state = { time: 0, visible: initialVisible, stalls: [] as Array<[number, number]> };
    const detector = createUiStallDetector({
      thresholdMs: UI_STALL_THRESHOLD_MS,
      suspendGapMs: UI_STALL_SUSPEND_GAP_MS,
      now: () => state.time,
      isVisible: () => state.visible,
      onStall: (lag, at) => state.stalls.push([lag, at]),
    });
    const tickAfter = (gapMs: number) => {
      state.time += gapMs;
      detector.tick(UI_STALL_CHECK_INTERVAL_MS);
    };
    return { state, detector, tickAfter };
  }

  it("stays quiet while timers fire on schedule or slightly late", () => {
    const { state, tickAfter } = setup();
    tickAfter(100);
    tickAfter(130);
    tickAfter(100 + UI_STALL_THRESHOLD_MS - 1);
    expect(state.stalls).toEqual([]);
  });

  it("treats a lag of exactly the threshold as a stall", () => {
    const { state, tickAfter } = setup();
    tickAfter(100);
    tickAfter(100 + UI_STALL_THRESHOLD_MS);
    expect(state.stalls).toEqual([[UI_STALL_THRESHOLD_MS, 450]]);
  });

  it("reports how late the timer fired once it reaches the threshold", () => {
    const { state, tickAfter } = setup();
    tickAfter(100);
    tickAfter(100 + 400);
    expect(state.stalls).toEqual([[400, 600]]);
    // The baseline moved on, so the next on-time tick is clean.
    tickAfter(100);
    expect(state.stalls).toHaveLength(1);
  });

  it("ignores gaps that look like system sleep or heavy throttling", () => {
    const { state, tickAfter } = setup();
    tickAfter(100);
    tickAfter(100 + UI_STALL_SUSPEND_GAP_MS);
    expect(state.stalls).toEqual([]);
  });

  it("does not report while hidden or on the first visible tick afterwards", () => {
    const { state, tickAfter } = setup();
    tickAfter(100);

    state.visible = false;
    tickAfter(5000);
    expect(state.stalls).toEqual([]);

    state.visible = true;
    tickAfter(5000); // the throttled timer finally fires after the page returned
    expect(state.stalls).toEqual([]);

    tickAfter(100 + 300); // a real stall after that is reported again
    expect(state.stalls).toEqual([[300, 10500]]);
  });

  it("skips one tick after markInterrupted", () => {
    const { state, detector, tickAfter } = setup();
    detector.markInterrupted();
    tickAfter(100 + 900);
    expect(state.stalls).toEqual([]);
    tickAfter(100 + 900);
    expect(state.stalls).toHaveLength(1);
  });

  it("reset forgets the baseline", () => {
    const { state, detector, tickAfter } = setup();
    state.time = 10_000;
    detector.reset();
    tickAfter(100);
    expect(state.stalls).toEqual([]);
  });
});

describe("describeInputTarget", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("describes an element without reading its text", () => {
    document.body.innerHTML = '<button id="run" class="btn primary extra" data-testid="run-query">Secret SQL text</button>';
    const text = describeInputTarget(document.getElementById("run"));
    expect(text).toBe("button#run.btn.primary[testid=run-query]");
    expect(text).not.toContain("Secret");
  });

  it("walks up to a recognisable ancestor and names the original target", () => {
    document.body.innerHTML = '<div class="cm-editor"><div class="cm-scroller"><div class="cm-content">select * from t</div></div></div>';
    const content = document.querySelector(".cm-content");
    expect(describeInputTarget(content)).toBe("div.cm-editor (from div)");
    expect(describeInputTarget(content)).not.toContain("select");
  });

  it("prefers the debug id and role of the element itself", () => {
    document.body.innerHTML = '<div role="textbox" data-debug-id="sql-editor" class="cm-content">x</div>';
    expect(describeInputTarget(document.querySelector(".cm-content"))).toBe("div.cm-content[role=textbox][debug-id=sql-editor]");
  });

  it("copes with non-element targets and caps the length", () => {
    expect(describeInputTarget(null)).toBe("unknown");
    expect(describeInputTarget(document)).toBe("unknown");
    document.body.innerHTML = `<div id="${"a".repeat(300)}"></div>`;
    const text = describeInputTarget(document.body.firstElementChild);
    expect(text.length).toBeLessThanOrEqual(123);
    expect(text.endsWith("...")).toBe(true);
  });
});

describe("installUiStallMonitor", () => {
  function setup(enabled: boolean) {
    const state = { time: 0, enabled, timers: [] as Array<{ callback: () => void; delay: number }>, cleared: [] as unknown[] };
    const reports: UiStallReport[] = [];
    const dispose = installUiStallMonitor({
      isEnabled: () => state.enabled,
      onStall: (report) => reports.push(report),
      now: () => state.time,
      setTimer: (callback, delay) => {
        state.timers.push({ callback, delay });
        return state.timers.length;
      },
      clearTimer: (handle) => state.cleared.push(handle),
    });
    /** Runs the pending timer after `elapsed` ms and returns the delay it scheduled next. */
    const fire = (elapsed: number) => {
      state.time += elapsed;
      const timer = state.timers[state.timers.length - 1];
      timer.callback();
      return state.timers[state.timers.length - 1].delay;
    };
    return { state, reports, dispose, fire };
  }

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("only polls slowly and never reports while logging is off", () => {
    const { state, reports, fire } = setup(false);
    expect(state.timers[0].delay).toBe(UI_STALL_IDLE_INTERVAL_MS);
    expect(fire(UI_STALL_IDLE_INTERVAL_MS + 5000)).toBe(UI_STALL_IDLE_INTERVAL_MS);
    expect(reports).toEqual([]);
  });

  it("speeds up once logging is enabled without reporting the idle gap as a stall", () => {
    const { state, reports, fire } = setup(false);
    fire(UI_STALL_IDLE_INTERVAL_MS);
    state.enabled = true;
    // The first active wake-up only resets the baseline.
    expect(fire(UI_STALL_IDLE_INTERVAL_MS)).toBe(UI_STALL_CHECK_INTERVAL_MS);
    expect(reports).toEqual([]);
    expect(fire(UI_STALL_CHECK_INTERVAL_MS)).toBe(UI_STALL_CHECK_INTERVAL_MS);
    expect(reports).toEqual([]);
  });

  it("reports a stall with the inputs handled inside the frozen window", () => {
    document.body.innerHTML = '<div class="cm-editor"><div class="cm-content">select 1</div></div><button id="b">go</button>';
    const { state, reports, fire } = setup(true);

    // An old click, long before the stall began (outside the reported window).
    state.time = 100;
    document.getElementById("b")?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    fire(UI_STALL_IDLE_INTERVAL_MS - 100); // t=2000: baseline reset, now measuring
    fire(UI_STALL_CHECK_INTERVAL_MS); // t=2100: on-time tick

    // A keydown and a wheel right before the main thread freezes until t=7770.
    state.time += 50;
    document.querySelector(".cm-content")?.dispatchEvent(new Event("keydown", { bubbles: true }));
    state.time += 20;
    document.querySelector(".cm-content")?.dispatchEvent(new Event("wheel", { bubbles: true }));
    state.time = 7770;
    fire(0);

    expect(reports).toHaveLength(1);
    const [report] = reports;
    expect(report.source).toBe("timer-drift");
    // The tick was due at 2100 + 100 and ran at 7770.
    expect(report.lagMs).toBe(5570);
    expect(report.visibility).toBe("visible");
    expect(report.recentInputs).toEqual([
      { type: "keydown", msBeforeTick: 5620, target: "div.cm-editor (from div)" },
      { type: "wheel", msBeforeTick: 5600, target: "div.cm-editor (from div)" },
    ]);
  });

  it("stops measuring and detaches its listeners when disposed", () => {
    const removed = vi.spyOn(document, "removeEventListener");
    const { state, dispose } = setup(true);
    dispose();
    expect(state.cleared).toHaveLength(1);
    const removedTypes = removed.mock.calls.map((call) => call[0]);
    expect(removedTypes).toEqual(expect.arrayContaining(["pointerdown", "keydown", "wheel", "visibilitychange"]));
    removed.mockRestore();
  });
});
