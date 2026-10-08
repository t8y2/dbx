// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_EXPIRED_EVENT, AUTH_FORCE_CHANGE_EVENT, deleteJdbcMavenBundle, dispatchWebAuthSessionEvent, executeMulti, loadConnections, sessionCredentialStatus, setAiGlobalCustomInstructions } from "@/lib/backend/http";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function trackEvents() {
  const events: string[] = [];
  const listener = (event: Event) => events.push(event.type);
  window.addEventListener(AUTH_EXPIRED_EVENT, listener);
  window.addEventListener(AUTH_FORCE_CHANGE_EVENT, listener);
  return {
    events,
    stop: () => {
      window.removeEventListener(AUTH_EXPIRED_EVENT, listener);
      window.removeEventListener(AUTH_FORCE_CHANGE_EVENT, listener);
    },
  };
}

describe("web auth session events on the HTTP transport primitives", () => {
  it.each([
    ["get", () => loadConnections()],
    ["post", () => sessionCredentialStatus("conn-1")],
    ["del", () => deleteJdbcMavenBundle("bundle-1")],
    ["put", () => setAiGlobalCustomInstructions("instructions")],
  ])("%s dispatches dbx:auth-expired on a 401 and still rejects", async (_primitive, action) => {
    const tracker = trackEvents();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "session_expired" }, 401)));
    try {
      await expect(action()).rejects.toThrow();
      expect(tracker.events).toEqual(["dbx:auth-expired"]);
    } finally {
      tracker.stop();
    }
  });

  it("dispatches dbx:auth-force-change only for 403 password_change_required", async () => {
    const tracker = trackEvents();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "password_change_required" }, 403)));
    try {
      await expect(loadConnections()).rejects.toThrow();
      expect(tracker.events).toEqual(["dbx:auth-force-change"]);
    } finally {
      tracker.stop();
    }
  });

  it("keeps a 403 with another error code silent", async () => {
    const tracker = trackEvents();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "forbidden" }, 403)));
    try {
      await expect(loadConnections()).rejects.toThrow();
      expect(tracker.events).toEqual([]);
    } finally {
      tracker.stop();
    }
  });

  it("keeps a 403 with a non-JSON body silent", async () => {
    const tracker = trackEvents();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 })));
    try {
      await expect(loadConnections()).rejects.toThrow();
      expect(tracker.events).toEqual([]);
    } finally {
      tracker.stop();
    }
  });

  it.each([
    ["/api/auth/login", 401, { error: "invalid_credentials" }],
    ["/api/auth/change-password", 403, { error: "blacklisted" }],
    ["api/auth/check", 401, { error: "invalid_credentials" }],
  ])("never dispatches session events for auth endpoints (%s)", async (url, status, body) => {
    const tracker = trackEvents();
    try {
      // The primitives only ever receive non-auth URLs; the guard itself is
      // exercised directly because a failed login must never kick the user
      // back to the login screen in a loop.
      await dispatchWebAuthSessionEvent(url, jsonResponse(body, status));
      expect(tracker.events).toEqual([]);
    } finally {
      tracker.stop();
    }
  });

  it("stays silent on ordinary failures", async () => {
    const tracker = trackEvents();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500)));
    try {
      await expect(loadConnections()).rejects.toThrow();
      expect(tracker.events).toEqual([]);
    } finally {
      tracker.stop();
    }
  });

  it("dispatches dbx:auth-expired from the query diagnostics transport too", async () => {
    const tracker = trackEvents();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "session_expired" }, 401)));
    try {
      await expect(executeMulti("conn-1", "db", "SELECT 1", undefined, "trace-1")).rejects.toThrow();
      expect(tracker.events).toEqual(["dbx:auth-expired"]);
    } finally {
      tracker.stop();
    }
  });

  it("still resolves successful requests without dispatching anything", async () => {
    const tracker = trackEvents();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([], 200)));
    try {
      await expect(loadConnections()).resolves.toEqual([]);
      expect(tracker.events).toEqual([]);
    } finally {
      tracker.stop();
    }
  });
});
