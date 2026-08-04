// @vitest-environment happy-dom

import { strict as assert } from "node:assert";
import { beforeEach, test, vi } from "vitest";

const runtimeMock = vi.hoisted(() => ({ isTauri: false }));
const dialogMock = vi.hoisted(() => ({ save: vi.fn() }));
const fsMock = vi.hoisted(() => ({
  writeTextFile: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({
  isTauriRuntime: () => runtimeMock.isTauri,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => dialogMock.save(...args),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: (...args: unknown[]) => fsMock.writeTextFile(...args),
  writeFile: (...args: unknown[]) => fsMock.writeFile(...args),
}));

const { saveDiagramBinaryExport, saveDiagramTextExport } = await import("../../apps/desktop/src/lib/export/saveDiagramExport.ts");

beforeEach(() => {
  runtimeMock.isTauri = false;
  dialogMock.save.mockReset();
  fsMock.writeTextFile.mockReset();
  fsMock.writeFile.mockReset();
});

test("Tauri text export returns false when save is cancelled", async () => {
  runtimeMock.isTauri = true;
  dialogMock.save.mockResolvedValue(null);
  const saved = await saveDiagramTextExport("diagram.svg", "<svg/>", "svg");
  assert.equal(saved, false);
  assert.equal(fsMock.writeTextFile.mock.calls.length, 0);
});

test("Tauri text export writes file when path chosen", async () => {
  runtimeMock.isTauri = true;
  dialogMock.save.mockResolvedValue("/tmp/out.svg");
  const saved = await saveDiagramTextExport("diagram.svg", "<svg/>", "svg");
  assert.equal(saved, true);
  assert.deepEqual(fsMock.writeTextFile.mock.calls[0]?.slice(0, 2), ["/tmp/out.svg", "<svg/>"]);
});

test("Tauri binary export writes bytes when path chosen", async () => {
  runtimeMock.isTauri = true;
  dialogMock.save.mockResolvedValue("/tmp/out.png");
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  const saved = await saveDiagramBinaryExport("diagram.png", blob, "png");
  assert.equal(saved, true);
  assert.equal(fsMock.writeFile.mock.calls[0]?.[0], "/tmp/out.png");
  assert.ok(fsMock.writeFile.mock.calls[0]?.[1] instanceof Uint8Array);
});

test("web text export triggers download and returns true", async () => {
  runtimeMock.isTauri = false;
  const clicks: string[] = [];
  const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:diagram");
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = originalCreateElement(tag);
    if (tag === "a") {
      el.click = () => {
        clicks.push(el.download);
      };
    }
    return el;
  });

  const saved = await saveDiagramTextExport("dbx-diagram.svg", "<svg/>", "svg");
  assert.equal(saved, true);
  assert.deepEqual(clicks, ["dbx-diagram.svg"]);
  createObjectURL.mockRestore();
  revokeObjectURL.mockRestore();
});
