// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const monitor = vi.hoisted(() => ({ install: vi.fn(), supportsLongTasks: vi.fn() }));

vi.mock("./uiStallMonitor", () => ({
  installUiStallMonitor: monitor.install,
  supportsLongTaskEntries: monitor.supportsLongTasks,
}));

const consoleMethods = ["debug", "info", "log", "warn", "error"] as const;

describe("debug log UI stall capture", () => {
  const originalConsole = Object.fromEntries(consoleMethods.map((method) => [method, console[method]])) as Record<(typeof consoleMethods)[number], (...args: unknown[]) => void>;

  beforeEach(() => {
    vi.resetModules();
    monitor.install.mockReset();
    monitor.supportsLongTasks.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    for (const method of consoleMethods) console[method] = originalConsole[method];
    vi.unstubAllGlobals();
  });

  it("measures timer drift on engines without the Long Tasks API and logs each stall", async () => {
    monitor.supportsLongTasks.mockReturnValue(false);
    const debugLog = await import("./debugLog");
    debugLog.setDebugLoggingEnabled(true);

    debugLog.installDebugLogCapture();

    expect(monitor.install).toHaveBeenCalledTimes(1);
    const deps = monitor.install.mock.calls[0][0] as { isEnabled: () => boolean; onStall: (report: unknown) => void };
    expect(deps.isEnabled()).toBe(true);

    deps.onStall({
      source: "timer-drift",
      lagMs: 812,
      visibility: "visible",
      hasFocus: true,
      recentInputs: [{ type: "keydown", msBeforeTick: 830, target: "div.cm-editor (from div)" }],
    });
    const text = debugLog.getDebugLogText();
    expect(text).toContain("[WARN] [performance:ui-stall]");
    expect(text).toContain('"lagMs":812');
    expect(text).toContain("div.cm-editor (from div)");
  });

  it("follows the logging switch so a disabled log costs only the idle poll", async () => {
    monitor.supportsLongTasks.mockReturnValue(false);
    const debugLog = await import("./debugLog");
    debugLog.installDebugLogCapture();
    const deps = monitor.install.mock.calls[0][0] as { isEnabled: () => boolean; onStall: (report: unknown) => void };

    expect(deps.isEnabled()).toBe(false);
    deps.onStall({ source: "timer-drift", lagMs: 900, visibility: "visible", hasFocus: true, recentInputs: [] });
    expect(debugLog.getDebugLogText()).not.toContain("ui-stall");

    debugLog.setDebugLoggingEnabled(true);
    expect(deps.isEnabled()).toBe(true);
  });

  it("keeps the Long Tasks observer and skips the monitor where the engine supports it", async () => {
    monitor.supportsLongTasks.mockReturnValue(true);
    const observe = vi.fn();
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        observe = observe;
      },
    );
    const debugLog = await import("./debugLog");

    debugLog.installDebugLogCapture();

    expect(monitor.install).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith({ entryTypes: ["longtask"] });
  });
});
