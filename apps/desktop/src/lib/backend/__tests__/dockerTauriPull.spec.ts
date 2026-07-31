import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { dockerPullImage } from "@/lib/backend/docker-tauri";

describe("Tauri Docker pull startup", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    mocks.unlisten.mockReset();
    mocks.listen.mockResolvedValue(mocks.unlisten);
    mocks.invoke.mockResolvedValue(undefined);
  });

  it("uses the caller session id so the pending task is updated in place", async () => {
    const handle = await dockerPullImage("connection-1", "example/app:latest", undefined, vi.fn(), { sessionId: "pending-pull" });

    expect(handle.sessionId).toBe("pending-pull");
    expect(mocks.invoke).toHaveBeenCalledWith("docker_pull_image", {
      connectionId: "connection-1",
      image: "example/app:latest",
      auth: undefined,
      sessionId: "pending-pull",
    });
  });

  it("stops the backend when cancellation happens while startup is pending", async () => {
    let finishStart: (() => void) | undefined;
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );
    const controller = new AbortController();
    const started = dockerPullImage("connection-1", "example/app:latest", undefined, vi.fn(), { sessionId: "pending-pull", signal: controller.signal });

    await vi.waitFor(() => expect(finishStart).toBeTypeOf("function"));
    controller.abort();
    finishStart?.();
    const handle = await started;

    expect(handle.sessionId).toBe("pending-pull");
    expect(mocks.invoke).toHaveBeenLastCalledWith("docker_stop_stream", { sessionId: "pending-pull" });
  });
});
