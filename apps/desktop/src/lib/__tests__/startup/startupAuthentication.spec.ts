// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { checkStartupAuthentication } from "@/lib/startup/startupAuthentication";

afterEach(() => vi.unstubAllGlobals());

describe("startup authentication", () => {
  it("preserves authenticated, disabled-auth and setup-required states", async () => {
    for (const state of [
      { required: true, authenticated: true, setup_required: false },
      { required: false, authenticated: false, setup_required: false },
      { required: true, authenticated: false, setup_required: true },
    ]) {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => state });
      vi.stubGlobal("fetch", fetchMock);
      expect(await checkStartupAuthentication()).toEqual(state);
      expect(fetchMock).toHaveBeenCalledWith("/api/auth/check", expect.objectContaining({ credentials: "same-origin" }));
    }
  });

  it.each([null, [], "invalid", {}, { required: "false", authenticated: true }, { required: false, authenticated: "true" }])("fails closed for malformed authentication data: %j", async (state) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => state }));
    await expect(checkStartupAuthentication()).rejects.toThrow("AUTH_CHECK_FAILED");
  });

  it("fails closed on unsuccessful responses and forwards cancellation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await expect(checkStartupAuthentication(controller.signal)).rejects.toThrow("AUTH_CHECK_FAILED");
    expect(fetchMock.mock.calls[0]?.[1].signal).toBe(controller.signal);
  });
});
