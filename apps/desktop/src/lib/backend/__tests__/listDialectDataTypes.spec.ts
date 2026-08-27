import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

describe("listDialectDataTypes backend adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the Tauri dialect command", async () => {
    mocks.invoke.mockResolvedValue(["INTEGER", "TEXT"]);
    const { listDialectDataTypes } = await import("@/lib/backend/tauri");

    await expect(listDialectDataTypes("PostgreSQL")).resolves.toEqual(["INTEGER", "TEXT"]);
    expect(mocks.invoke).toHaveBeenCalledWith("list_dialect_data_types", { dialectName: "PostgreSQL" });
  });

  it("uses the matching Web dialect route", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(["INTEGER", "TEXT"]),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { listDialectDataTypes } = await import("@/lib/backend/http");

    await expect(listDialectDataTypes("PostgreSQL")).resolves.toEqual(["INTEGER", "TEXT"]);
    expect(fetchMock).toHaveBeenCalledWith("/api/dialect/data-types?dialect_name=PostgreSQL");
  });

  it("threads the abort signal through to fetch when present", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([]),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { listDatabases } = await import("@/lib/backend/http");
    const controller = new AbortController();

    await expect(listDatabases("conn-1", controller.signal)).resolves.toEqual([]);
    // The signal must be threaded as the second fetch argument so an in-flight
    // metadata request can be aborted; the no-signal path keeps the classic
    // single-argument fetch shape (see the dialect route test above).
    expect(fetchMock).toHaveBeenCalledWith("/api/schema/databases?connection_id=conn-1", {
      signal: controller.signal,
    });
  });
});
