// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    getRunLogs: vi.fn(),
    emitEvent: null as null | ((event: unknown) => void),
  };
});

vi.mock("@/lib/scheduler/schedulerApi", () => ({
  getRunLogs: mocks.getRunLogs,
}));

vi.mock("@/lib/scheduler/schedulerEvents", () => ({
  subscribeSchedulerEvents: async (onEvent: (event: unknown) => void) => {
    mocks.emitEvent = onEvent;
    return () => {
      mocks.emitEvent = null;
    };
  },
}));

import i18n from "../../../i18n";
import SchedulerLogViewer from "../SchedulerLogViewer.vue";
import type { SchedulerEvent } from "@/lib/scheduler/schedulerTypes";

const mountedApps: App[] = [];

function entry(seq: number, message: string) {
  return { seq, timestamp: `2026-10-05T02:00:${String(seq % 60).padStart(2, "0")}Z`, level: "info" as const, stream: "stdout" as const, message };
}

async function mountViewer(runStatus: "running" | "success" = "running") {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(SchedulerLogViewer, { runId: "run-1", runStatus });
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  // Fake timers are active, so flush with timer advancement, not setTimeout.
  await vi.advanceTimersByTimeAsync(0);
  await nextTick();
  return container;
}

beforeEach(() => {
  mocks.getRunLogs.mockReset();
  mocks.emitEvent = null;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  while (mountedApps.length) mountedApps.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("SchedulerLogViewer", () => {
  it("loads one snapshot and appends live events without refetching", async () => {
    mocks.getRunLogs.mockResolvedValue({ entries: [entry(1, "backup started"), entry(2, "dumping")], nextSeq: 3, eof: true });
    await mountViewer("running");
    expect(mocks.getRunLogs).toHaveBeenCalledTimes(1);
    expect(mocks.getRunLogs).toHaveBeenCalledWith("run-1", { afterSeq: 0, limit: 500 });
    expect(document.body.querySelectorAll("[data-scheduler-log-seq]")).toHaveLength(2);

    // Live event append: no extra fetch, seqs deduped.
    const event: SchedulerEvent = { type: "run-log", runId: "run-1", entries: [entry(2, "duplicate ignored"), entry(3, "almost done")] };
    mocks.emitEvent?.(event);
    await nextTick();
    expect(mocks.getRunLogs).toHaveBeenCalledTimes(1);
    const seqs = [...document.body.querySelectorAll("[data-scheduler-log-seq]")].map((node) => node.getAttribute("data-scheduler-log-seq"));
    expect(seqs).toEqual(["1", "2", "3"]);
  });

  it("ignores events from other runs", async () => {
    mocks.getRunLogs.mockResolvedValue({ entries: [entry(1, "only mine")], nextSeq: 2, eof: true });
    await mountViewer("running");
    mocks.emitEvent?.({ type: "run-log", runId: "run-other", entries: [entry(9, "not mine")] } satisfies SchedulerEvent);
    await nextTick();
    expect(document.body.querySelectorAll("[data-scheduler-log-seq]")).toHaveLength(1);
  });

  it("tails incrementally with afterSeq while the run is active", async () => {
    mocks.getRunLogs.mockResolvedValue({ entries: [entry(1, "first page")], nextSeq: 2, eof: false });
    await mountViewer("running");
    mocks.getRunLogs.mockClear();
    mocks.getRunLogs.mockResolvedValue({ entries: [entry(2, "second page")], nextSeq: 3, eof: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.getRunLogs).toHaveBeenCalledTimes(1);
    expect(mocks.getRunLogs).toHaveBeenCalledWith("run-1", { afterSeq: 2, limit: 500 });
    expect(document.body.textContent).toContain("second page");
    // eof reached and run finished: no further polling.
    mocks.getRunLogs.mockClear();
    await vi.advanceTimersByTimeAsync(20000);
    expect(mocks.getRunLogs).not.toHaveBeenCalled();
  });

  it("does not poll finished runs", async () => {
    mocks.getRunLogs.mockResolvedValue({ entries: [entry(1, "done")], nextSeq: 2, eof: true });
    await mountViewer("success");
    mocks.getRunLogs.mockClear();
    await vi.advanceTimersByTimeAsync(15000);
    expect(mocks.getRunLogs).not.toHaveBeenCalled();
  });
});
