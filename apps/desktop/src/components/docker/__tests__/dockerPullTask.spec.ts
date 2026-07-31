import { afterEach, describe, expect, it, vi } from "vitest";
import { createPendingDockerPullTask } from "@/components/docker/dockerPullTask";
import { dockerPullImage } from "@/lib/backend/http";

describe("Docker pull task startup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a visible cancellable task before the HTTP request resolves", async () => {
    const pending = createPendingDockerPullTask("private.example/app:latest");
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(pending.progress.status).toBe("running");
    expect(pending.progress.bytesCompleted).toBe(0);
    const started = dockerPullImage("connection-1", pending.progress.image, undefined, vi.fn(), pending.options);
    await pending.handle.stop();

    expect(pending.options.signal?.aborted).toBe(true);
    await expect(started).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
