// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { webChangePassword, webLogin, webLogout, webSetup, WebAuthError } from "@/lib/auth/webAuth";

afterEach(() => vi.unstubAllGlobals());

const successPayload = {
  required: true,
  authenticated: true,
  setup_required: false,
  user: { username: "admin", display_name: null, is_admin: true, department_name: null, roles: [] },
  permissions: ["query.read"],
  must_change_password: false,
  password_expires_in_days: 90,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("webAuth transport", () => {
  it("posts username/password credentials to the login endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(successPayload));
    vi.stubGlobal("fetch", fetchMock);

    const result = await webLogin("admin", "secret");

    expect(result).toEqual(successPayload);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username: "admin", password: "secret" }),
    });
  });

  it("posts username/password credentials to the setup endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(successPayload));
    vi.stubGlobal("fetch", fetchMock);

    await webSetup("admin", "secret");

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username: "admin", password: "secret" }),
    });
  });

  it.each([
    ["login", () => webLogin("admin", "wrong"), 401],
    ["setup", () => webSetup("admin", "secret"), 409],
  ])("%s failures surface the body error code with the status", async (_name, action, status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "already_initialized" }, status)));
    await expect(action()).rejects.toMatchObject({ status, code: "already_initialized" });
  });

  it("carries a null code when the failure body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("gateway timeout", { status: 502 })));
    await expect(webLogin("admin", "secret")).rejects.toBeInstanceOf(WebAuthError);
    await expect(webLogin("admin", "secret")).rejects.toMatchObject({ status: 502, code: null });
  });

  it("posts old_password/new_password to the change-password endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await webChangePassword("old-pass", "new-pass");

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ old_password: "old-pass", new_password: "new-pass" }),
    });
  });

  it("reports invalid credentials from change-password as a coded error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "invalid_credentials" }, 401)));
    await expect(webChangePassword("wrong", "new-pass")).rejects.toMatchObject({ status: 401, code: "invalid_credentials" });
  });

  it("calls the logout endpoint with same-origin credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await webLogout();

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  });
});
