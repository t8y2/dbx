import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("web SSH prompt API", () => {
  it("posts the host-key resolution to the authenticated web endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(null),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { resolveSshPrompt } = await import("@/lib/backend/http");
    await resolveSshPrompt({ id: "prompt-1", action: "accept", remember: true });

    expect(fetchMock).toHaveBeenCalledWith("/api/ssh/prompts/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "prompt-1", action: "accept", remember: true }),
    });
  });
});
