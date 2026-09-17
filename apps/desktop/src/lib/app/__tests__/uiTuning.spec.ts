import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = {
  exists: vi.fn(),
  readTextFile: vi.fn(),
};

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/path", () => ({
  homeDir: () => Promise.resolve("/home/tester"),
  join: (_home: string, ...parts: string[]) => Promise.resolve(["/home/tester", ...parts].join("/")),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: (path: string) => fs.exists(path),
  readTextFile: (path: string) => fs.readTextFile(path),
}));

async function loadFresh() {
  vi.resetModules();
  const module = await import("../uiTuning");
  await module.loadUiTuning();
  return module;
}

describe("uiTuning", () => {
  beforeEach(() => {
    fs.exists.mockReset();
    fs.readTextFile.mockReset();
  });

  it("uses the defaults when ~/.dbx/ui-tuning.json is absent", async () => {
    fs.exists.mockResolvedValue(false);
    const { uiTuning, DEFAULT_UI_TUNING } = await loadFresh();
    expect(uiTuning.value.panelResizeTrackEveryFrames).toBe(DEFAULT_UI_TUNING.panelResizeTrackEveryFrames);
  });

  it("clamps out-of-range values from the tuning file", async () => {
    fs.exists.mockResolvedValue(true);
    fs.readTextFile.mockResolvedValue(JSON.stringify({ panelResizeTrackEveryFrames: 99 }));
    const { uiTuning } = await loadFresh();
    expect(uiTuning.value.panelResizeTrackEveryFrames).toBe(10);
  });

  it("falls back to defaults on malformed json", async () => {
    fs.exists.mockResolvedValue(true);
    fs.readTextFile.mockResolvedValue("{ not json");
    const { uiTuning, DEFAULT_UI_TUNING } = await loadFresh();
    expect(uiTuning.value.panelResizeTrackEveryFrames).toBe(DEFAULT_UI_TUNING.panelResizeTrackEveryFrames);
  });

  it("accepts a valid in-range value", async () => {
    fs.exists.mockResolvedValue(true);
    fs.readTextFile.mockResolvedValue(JSON.stringify({ panelResizeTrackEveryFrames: 2 }));
    const { uiTuning } = await loadFresh();
    expect(uiTuning.value.panelResizeTrackEveryFrames).toBe(2);
    expect(fs.exists).toHaveBeenCalledWith("/home/tester/.dbx/ui-tuning.json");
    expect(fs.readTextFile).toHaveBeenCalledWith("/home/tester/.dbx/ui-tuning.json");
  });

  it.each(["exists", "readTextFile"] as const)("keeps defaults when %s access is denied", async (command) => {
    fs.exists.mockResolvedValue(true);
    fs[command].mockRejectedValue(new Error("path not allowed"));
    const { uiTuning, DEFAULT_UI_TUNING, loadUiTuning } = await loadFresh();
    expect(uiTuning.value).toEqual(DEFAULT_UI_TUNING);
    await loadUiTuning();
    expect(fs.exists).toHaveBeenCalledTimes(1);
    expect(fs.readTextFile).toHaveBeenCalledTimes(command === "exists" ? 0 : 1);
  });
});
