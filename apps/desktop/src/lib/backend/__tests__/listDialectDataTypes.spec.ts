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
});
