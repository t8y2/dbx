// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { checkStartupAuthentication, normalizeStartupAuthentication } from "@/lib/startup/startupAuthentication";

afterEach(() => vi.unstubAllGlobals());

const fullShape = {
  required: true,
  authenticated: true,
  setup_required: false,
  user: {
    username: "admin",
    display_name: "Administrator",
    is_admin: true,
    department_name: "IT",
    roles: ["dba"],
  },
  permissions: ["query.read", "query.write"],
  must_change_password: false,
  password_expires_in_days: 90,
};

describe("startup authentication", () => {
  it("preserves authenticated, disabled-auth and setup-required states", async () => {
    for (const state of [
      { required: true, authenticated: true, setup_required: false },
      { required: false, authenticated: false, setup_required: false },
      { required: true, authenticated: false, setup_required: true },
    ]) {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => state });
      vi.stubGlobal("fetch", fetchMock);
      expect(await checkStartupAuthentication()).toEqual({
        ...state,
        user: null,
        permissions: [],
        must_change_password: false,
        password_expires_in_days: null,
      });
      expect(fetchMock).toHaveBeenCalledWith("/api/auth/check", expect.objectContaining({ credentials: "same-origin" }));
    }
  });

  it("passes the full auth contract through (user, permissions, forced change, expiry)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => fullShape });
    vi.stubGlobal("fetch", fetchMock);

    expect(await checkStartupAuthentication()).toEqual(fullShape);
  });

  it("normalizes optional user fields and filters malformed permission entries", () => {
    const normalized = normalizeStartupAuthentication({
      required: true,
      authenticated: true,
      user: { username: "ops", display_name: 42, is_admin: "yes", department_name: null, roles: ["dba", 7] },
      permissions: ["query.read", 3, null],
      must_change_password: 1,
      password_expires_in_days: "soon",
    });
    expect(normalized).toEqual({
      required: true,
      authenticated: true,
      setup_required: false,
      user: { username: "ops", display_name: null, is_admin: false, department_name: null, roles: ["dba"] },
      permissions: ["query.read"],
      must_change_password: false,
      password_expires_in_days: null,
    });
  });

  it("rejects malformed user objects by nulling the user", () => {
    const normalized = normalizeStartupAuthentication({ required: true, authenticated: true, user: { display_name: "no-username" } });
    expect(normalized).not.toBeNull();
    expect(normalized!.user).toBeNull();
    expect(normalized!.permissions).toEqual([]);
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
