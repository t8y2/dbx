// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import WebCurrentUserInfo from "../WebCurrentUserInfo.vue";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mount(): { root: HTMLElement; app: App } {
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(WebCurrentUserInfo);
  app.mount(root);
  return { root, app };
}

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

describe("WebCurrentUserInfo", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("shows the session identity with localized role and provider label", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        authenticated: true,
        required: true,
        setup_required: false,
        user: { username: "bob", role: "admin", provider_id: "sso" },
        providers: [
          { id: "local", kind: "local", label: "Local", mode: "form", requires_username: false },
          { id: "sso", kind: "oidc", label: "Mock SSO", mode: "redirect", requires_username: false },
        ],
      }),
    );
    const { root, app } = mount();
    await flush();

    expect(root.querySelector('[data-testid="current-user"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="current-user-name"]')?.textContent).toBe("bob");
    const summary = root.querySelector('[data-testid="current-user-summary"]')?.textContent ?? "";
    expect(summary).toContain("auth.roleAdmin");
    expect(summary).toContain("Mock SSO");
    app.unmount();
  });

  it("falls back to the member role and the raw provider id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        authenticated: true,
        user: { username: "dave", role: "member", provider_id: "ldap" },
        providers: [],
      }),
    );
    const { root, app } = mount();
    await flush();

    const summary = root.querySelector('[data-testid="current-user-summary"]')?.textContent ?? "";
    expect(summary).toContain("auth.roleMember");
    expect(summary).toContain("ldap");
    app.unmount();
  });

  it("renders nothing when the session is not authenticated", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ authenticated: false, required: true, setup_required: false }));
    const { root, app } = mount();
    await flush();

    expect(root.querySelector('[data-testid="current-user"]')).toBeNull();
    app.unmount();
  });
});
