import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("offline Agent and standalone JRE import", () => {
  it("returns separate driver and JRE counts from the desktop command", async () => {
    const { importAgentsFromZip } = await import("../tauri");
    mocks.invoke.mockResolvedValue({ count: 0, jreCount: 1 });
    expect(await importAgentsFromZip("/tmp/renamed.tar.zst", "import-1")).toEqual({ count: 0, jreCount: 1 });
    expect(mocks.invoke).toHaveBeenCalledWith("import_agents_from_zip", { path: "/tmp/renamed.tar.zst", operationId: "import-1" });
  });

  it("uploads standalone JRE packages and preserves both result counts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ count: 0, jreCount: 1 })));
    vi.stubGlobal("fetch", fetchMock);
    const { importAgentsFromZip } = await import("../http");
    const file = new File(["archive"], "renamed.tar.zst");
    expect(await importAgentsFromZip(file, "import-2")).toEqual({ count: 0, jreCount: 1 });
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/agents/import-offline");
    expect(request.method).toBe("POST");
    expect(request.body.get("operationId")).toBe("import-2");
    expect(request.body.get("file").name).toBe(file.name);
  });

  it("remains compatible with web backends that only return a driver count", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ count: 2 }))));
    const { importAgentsFromZip } = await import("../http");
    expect(await importAgentsFromZip(new File(["archive"], "drivers.zip"))).toEqual({ count: 2, jreCount: 0 });
  });
});
