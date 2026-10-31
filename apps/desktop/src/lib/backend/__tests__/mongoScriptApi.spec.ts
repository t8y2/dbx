import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MongoScriptRequest, MongoScriptResult } from "@/lib/mongo/mongoScript";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const request: MongoScriptRequest = {
  connectionId: "mongo-1",
  database: "app",
  source: "print(db.version())",
  executionId: "exec-1",
  maxRows: 100,
  timeoutSecs: 30,
  dangerousOperationConfirmed: true,
};

const result: MongoScriptResult = {
  finalValue: { ok: true },
  output: [{ kind: "text", value: "done" }],
  operationCount: 1,
  succeededOperationCount: 1,
  currentDatabase: "app",
  truncated: false,
};

describe("MongoDB JavaScript transport parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("passes the complete request through the Tauri command", async () => {
    mocks.invoke.mockResolvedValue(result);
    const { mongoExecuteScript } = await import("@/lib/backend/tauri");

    await expect(mongoExecuteScript(request)).resolves.toEqual(result);
    expect(mocks.invoke).toHaveBeenCalledWith("mongo_execute_script", { request });
  });

  it("posts the same request shape to WebUI", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(result) });
    vi.stubGlobal("fetch", fetchMock);
    const { mongoExecuteScript } = await import("@/lib/backend/http");

    await expect(mongoExecuteScript(request)).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith("/api/mongo/execute-script", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  });
});
