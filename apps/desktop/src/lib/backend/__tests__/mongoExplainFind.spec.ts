import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const options = { skip: 2, limit: 10, filter: '{"active":true}', projection: '{"name":1}', sort: '{"name":1}', collation: '{"locale":"en"}', verbosity: "executionStats" };
const plan = { queryPlanner: { namespace: "app.users" } };

describe("MongoDB find explain adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["explain-1", undefined])("forwards optional executionId %s through HTTP", async (executionId) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(plan) });
    vi.stubGlobal("fetch", fetchMock);
    const { mongoExplainFind } = await import("@/lib/backend/http");

    const result = executionId === undefined ? await mongoExplainFind("mongo-1", "app", "users", options) : await mongoExplainFind("mongo-1", "app", "users", options, executionId);

    expect(result).toEqual(plan);
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe("/api/mongo/explain-find");
    expect(JSON.parse(String(init.body))).toEqual({ connectionId: "mongo-1", database: "app", collection: "users", ...options, ...(executionId === undefined ? {} : { executionId }) });
  });

  it.each(["explain-1", undefined])("forwards optional executionId %s through Tauri", async (executionId) => {
    mocks.invoke.mockResolvedValue(plan);
    const { mongoExplainFind } = await import("@/lib/backend/tauri");

    const result = executionId === undefined ? await mongoExplainFind("mongo-1", "app", "users", options) : await mongoExplainFind("mongo-1", "app", "users", options, executionId);

    expect(result).toEqual(plan);
    expect(mocks.invoke).toHaveBeenCalledWith("mongo_explain_find", { connectionId: "mongo-1", database: "app", collection: "users", ...options, executionId });
  });
});
