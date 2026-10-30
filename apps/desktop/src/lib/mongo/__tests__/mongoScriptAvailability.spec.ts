import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ mongoScriptAvailable: vi.fn() }));

vi.mock("@/lib/backend/api", () => ({ mongoScriptAvailable: mocks.mongoScriptAvailable }));

describe("useMongoScriptAvailable", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.mongoScriptAvailable.mockReset();
  });

  it("asks the backend once and shares the answer", async () => {
    mocks.mongoScriptAvailable.mockResolvedValue(true);
    const { useMongoScriptAvailable } = await import("@/lib/mongo/mongoScriptAvailability");
    const first = useMongoScriptAvailable();
    const second = useMongoScriptAvailable();
    expect(first.value).toBe(false);
    await vi.waitFor(() => expect(first.value).toBe(true));
    expect(second.value).toBe(true);
    expect(mocks.mongoScriptAvailable).toHaveBeenCalledOnce();
  });

  it("stays unavailable when the backend cannot answer, and asks again later", async () => {
    mocks.mongoScriptAvailable.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(false);
    const { useMongoScriptAvailable } = await import("@/lib/mongo/mongoScriptAvailability");
    const available = useMongoScriptAvailable();
    await vi.waitFor(() => expect(mocks.mongoScriptAvailable).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    useMongoScriptAvailable();
    await vi.waitFor(() => expect(mocks.mongoScriptAvailable).toHaveBeenCalledTimes(2));
    expect(available.value).toBe(false);
  });
});
