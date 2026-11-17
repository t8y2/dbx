import { afterEach, describe, expect, it, vi } from "vitest";
import { checkStartupAuthentication, logoutWeb } from "@/lib/startup/startupAuthentication";

/**
 * Additive-field parsing for multi-provider auth: legacy backends (without providers/user)
 * must keep working; malformed providers/user shapes from new backends are silently dropped instead of thrown.
 */
describe("checkStartupAuthentication", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses legacy responses without providers and user", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ required: true, authenticated: false, setup_required: false }), { status: 200 })),
    );
    const result = await checkStartupAuthentication();
    expect(result.required).toBe(true);
    expect(result.providers).toBeUndefined();
    expect(result.user).toBeUndefined();
  });

  it("parses providers and user from the extended response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              required: true,
              authenticated: true,
              setup_required: false,
              providers: [
                { id: "local", kind: "local", label: "Local", mode: "form", requires_username: false },
                { id: "corp-ldap", kind: "ldap", label: "Corp LDAP", mode: "form", requires_username: true },
                { id: "sso", kind: "oidc", label: "SSO", mode: "redirect", requires_username: false },
              ],
              user: { username: "alice", role: "admin", provider_id: "local" },
            }),
            { status: 200 },
          ),
      ),
    );
    const result = await checkStartupAuthentication();
    expect(result.providers).toHaveLength(3);
    expect(result.providers?.[1]).toEqual({ id: "corp-ldap", kind: "ldap", label: "Corp LDAP", mode: "form", requires_username: true });
    expect(result.user?.username).toBe("alice");
  });

  it("drops malformed provider entries instead of failing startup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              required: false,
              authenticated: true,
              setup_required: false,
              providers: [{ id: "broken" }, "not-an-object", null, { id: "ok", kind: "ldap", label: "L", mode: "form", requires_username: false }],
            }),
            { status: 200 },
          ),
      ),
    );
    const result = await checkStartupAuthentication();
    expect(result.providers).toHaveLength(1);
    expect(result.providers?.[0].id).toBe("ok");
  });
});

/** RP-initiated logout: legacy backends return no logout_url; SSO sessions return the IdP end-session URL. */
describe("logoutWeb", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces the IdP end-session URL from an SSO logout response", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, logout_url: "http://idp/logout?client_id=demo" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await logoutWeb();
    expect(result.logoutUrl).toBe("http://idp/logout?client_id=demo");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/auth/logout"), expect.objectContaining({ method: "POST" }));
  });

  it("returns no logoutUrl for legacy backends without the field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    const result = await logoutWeb();
    expect(result.logoutUrl).toBeUndefined();
  });

  it("rejects non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    await expect(logoutWeb()).rejects.toThrow("AUTH_LOGOUT_FAILED");
  });
});
