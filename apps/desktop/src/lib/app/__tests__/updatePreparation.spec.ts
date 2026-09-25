// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";
import { acquireUpdateBarrier, beginUpdateSensitiveOperation, prepareUpdateWithDraftRecovery, UPDATE_RESTORE_KEY, assertUpdateAllowsCommand, assertUpdateSafe, setupUpdatePreparation, useUpdateBlocker } from "../updatePreparation";
import i18n, { loadLocaleMessages } from "@/i18n";

const bus = vi.hoisted(() => ({ label: "main", members: ["main"] as string[], listeners: new Map<string, Set<{ label: string; callback: (event: any) => unknown }>>() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: bus.label }), getAllWebviewWindows: async () => bus.members.map((label) => ({ label })) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, callback: (event: any) => unknown) => {
    const entry = { label: bus.label, callback };
    const listeners = bus.listeners.get(event) ?? new Set();
    listeners.add(entry);
    bus.listeners.set(event, listeners);
    return () => listeners.delete(entry);
  },
  emit: async (event: string, payload: unknown) => {
    for (const listener of bus.listeners.get(event) ?? []) void listener.callback({ payload });
  },
  emitTo: async (label: string, event: string, payload: unknown) => {
    for (const listener of bus.listeners.get(event) ?? []) if (listener.label === label) void listener.callback({ payload });
  },
}));
afterEach(() => {
  bus.listeners.clear();
  bus.members = ["main"];
  bus.label = "main";
  vi.useRealTimers();
});

describe("update restart preparation", () => {
  it("translates a pending window operation using the current locale", async () => {
    const previousLocale = i18n.global.locale.value;
    await loadLocaleMessages("zh-CN");
    const release = beginUpdateSensitiveOperation();
    try {
      i18n.global.locale.value = "zh-CN";
      expect(assertUpdateSafe).toThrow("请等待当前窗口操作完成后再更新。");
      i18n.global.locale.value = "en";
      expect(assertUpdateSafe).toThrow("Please wait for the current window operation to finish before updating.");
    } finally {
      release();
      i18n.global.locale.value = previousLocale;
    }
  });

  it("marks recovery only after all preparation succeeds and preserves recovery when relaunch fails", async () => {
    const storage = new Map<string, string>();
    const disk = {
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    };
    await expect(
      prepareUpdateWithDraftRecovery(async () => {
        throw new Error("companion failed");
      }, disk),
    ).rejects.toThrow("companion failed");
    expect(storage.has(UPDATE_RESTORE_KEY)).toBe(false);
    const release = vi.fn();
    const undo = await prepareUpdateWithDraftRecovery(async () => release, disk);
    expect(storage.get(UPDATE_RESTORE_KEY)).toBe("1");
    undo();
    expect(storage.get(UPDATE_RESTORE_KEY)).toBe("1");
    expect(release).toHaveBeenCalledOnce();
  });
  it("releases the barrier when saving the recovery marker fails", async () => {
    const release = vi.fn();
    const disk = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage unavailable");
      },
      removeItem: vi.fn(),
    };
    await expect(prepareUpdateWithDraftRecovery(async () => release, disk)).rejects.toThrow("storage unavailable");
    expect(release).toHaveBeenCalledOnce();
  });

  it("blocks native task commands and input until explicitly released", () => {
    const release = acquireUpdateBarrier();
    expect(() => assertUpdateAllowsCommand("execute_query")).toThrow();
    expect(() => assertUpdateAllowsCommand("unknown_future_mutation")).toThrow();
    expect(() => assertUpdateAllowsCommand("save_open_tabs_state")).not.toThrow();
    expect(() => assertUpdateAllowsCommand("install_downloaded_update")).not.toThrow();
    const event = new Event("beforeinput", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    release();
    release();
    expect(() => assertUpdateAllowsCommand("execute_query")).not.toThrow();
  });
  it("removes editor vetoes when their scope is disposed", () => {
    const scope = effectScope();
    scope.run(() => useUpdateBlocker(() => "unsaved Redis value"));
    expect(assertUpdateSafe).toThrow("unsaved Redis value");
    scope.stop();
    expect(assertUpdateSafe).not.toThrow();
  });
  it("waits for every window to save and holds the barrier until release", async () => {
    bus.members = ["main", "detached-tab-one"];
    const persist = vi.fn(async () => {});
    const main = await setupUpdatePreparation({ assertSafe() {}, persist });
    bus.label = "detached-tab-one";
    const detached = await setupUpdatePreparation({ assertSafe() {}, persist });
    const release = await main.prepare();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(() => assertUpdateAllowsCommand("execute_query")).toThrow();
    release();
    expect(() => assertUpdateAllowsCommand("execute_query")).not.toThrow();
    main.dispose();
    detached.dispose();
  });
  it("releases all windows if a draft write fails", async () => {
    const main = await setupUpdatePreparation({
      assertSafe() {},
      persist: async () => {
        throw new Error("disk full");
      },
    });
    await expect(main.prepare()).rejects.toThrow("disk full");
    expect(() => assertUpdateAllowsCommand("execute_query")).not.toThrow();
    main.dispose();
  });
  it("fails if a new window appears while saving", async () => {
    const main = await setupUpdatePreparation({
      assertSafe() {},
      persist: async () => {
        bus.members.push("late-window");
      },
    });
    await expect(main.prepare()).rejects.toThrow("Open windows changed");
    expect(() => assertUpdateAllowsCommand("execute_query")).not.toThrow();
    main.dispose();
  });
  it("times out a hung local disk write even without other windows", async () => {
    vi.useFakeTimers();
    const main = await setupUpdatePreparation({ assertSafe() {}, persist: () => new Promise(() => {}) });
    const result = expect(main.prepare()).rejects.toThrow("5 seconds");
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(() => assertUpdateAllowsCommand("execute_query")).not.toThrow();
    main.dispose();
  });
  it("times out an unresponsive window after five seconds", async () => {
    vi.useFakeTimers();
    bus.members.push("unresponsive");
    const main = await setupUpdatePreparation({ assertSafe() {}, persist: async () => {} });
    const result = expect(main.prepare()).rejects.toThrow("5 seconds");
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(() => assertUpdateAllowsCommand("execute_query")).not.toThrow();
    main.dispose();
  });
});
