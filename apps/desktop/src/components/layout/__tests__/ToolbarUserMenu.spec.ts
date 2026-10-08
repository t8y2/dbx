// @vitest-environment happy-dom

import { createApp, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/auth/webAuth", () => ({
  webLogout: webAuthMocks.logout,
  // ChangePasswordDialog imports these from the same module; stub them so the
  // component graph loads cleanly under the mock.
  webChangePassword: vi.fn(),
  WebAuthError: class MockWebAuthError extends Error {},
}));

import ToolbarUserMenu from "@/components/layout/ToolbarUserMenu.vue";
import { useAuthStore } from "@/stores/authStore";

const webAuthMocks = vi.hoisted(() => ({ logout: vi.fn() }));

let root: HTMLDivElement;
let mountedApp: ReturnType<typeof createApp> | undefined;
let replaceMock: ReturnType<typeof vi.fn>;

function applyUser(overrides: Record<string, unknown> = {}) {
  const auth = useAuthStore();
  auth.applyCheckResponse({
    required: true,
    authenticated: true,
    setup_required: false,
    user: {
      username: "ops.user",
      display_name: "Ops User",
      is_admin: false,
      department_name: "Platform Team",
      roles: ["dba", "auditor"],
    },
    permissions: ["query.read"],
    must_change_password: false,
    password_expires_in_days: 90,
    ...overrides,
  });
  return auth;
}

function mountMenu() {
  mountedApp = createApp({ render: () => h(ToolbarUserMenu) });
  mountedApp.use(createPinia());
  mountedApp.config.errorHandler = vi.fn();
  mountedApp.mount(root);
}

async function openMenu() {
  (document.querySelector("[data-user-menu-trigger]") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.querySelector("[data-user-menu-department]")).not.toBeNull());
}

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  webAuthMocks.logout.mockReset();
  webAuthMocks.logout.mockResolvedValue(undefined);
  replaceMock = vi.fn();
  vi.stubGlobal("location", { pathname: "/", replace: replaceMock });
});

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = undefined;
  root.remove();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ToolbarUserMenu", () => {
  it("renders nothing while unauthenticated", async () => {
    mountMenu();
    await nextTick();
    expect(document.querySelector("[data-user-menu-trigger]")).toBeNull();
  });

  it("shows the username chip with the capitalized display-name initial", async () => {
    mountMenu();
    applyUser();
    await nextTick();
    const trigger = document.querySelector("[data-user-menu-trigger]")!;
    expect(trigger.textContent).toContain("ops.user");
    const initial = trigger.querySelector("span")!.textContent;
    expect(initial).toBe("O");
  });

  it("falls back to the username initial when display_name is absent", async () => {
    mountMenu();
    applyUser({ user: { username: "ops.user", display_name: null, is_admin: false, department_name: null, roles: [] } });
    await nextTick();
    expect(document.querySelector("[data-user-menu-trigger]")!.querySelector("span")!.textContent).toBe("O");
  });

  it("lists the department, roles and display name in the dropdown", async () => {
    mountMenu();
    applyUser();
    await nextTick();
    await openMenu();

    expect(document.querySelector("[data-user-menu-department]")!.textContent).toContain("Platform Team");
    const roleChips = [...document.querySelectorAll("[data-user-menu-roles] span span")].map((chip) => chip.textContent);
    expect(roleChips).toEqual(["dba", "auditor"]);
    expect(document.querySelector("[data-user-menu-password-expiry]")).toBeNull();
  });

  it("warns when the password expires within 7 days", async () => {
    mountMenu();
    applyUser({ password_expires_in_days: 3 });
    await nextTick();
    await openMenu();

    const expiry = document.querySelector("[data-user-menu-password-expiry]")!;
    expect(expiry.textContent).toContain("auth.passwordExpiresInDays");
  });

  it("shows the expired state at zero days", async () => {
    mountMenu();
    applyUser({ password_expires_in_days: 0 });
    await nextTick();
    await openMenu();

    expect(document.querySelector("[data-user-menu-password-expiry]")!.textContent).toContain("auth.passwordExpired");
  });

  it("opens the voluntary change-password dialog from the menu", async () => {
    mountMenu();
    applyUser();
    await nextTick();
    await openMenu();

    (document.querySelector("[data-user-menu-change-password]") as HTMLElement).click();
    await vi.waitFor(() => expect(document.querySelector("[data-change-password-dialog]")).not.toBeNull());
    expect(document.querySelector("[data-change-password-cancel]")).not.toBeNull();
  });

  it("logs out after confirmation: endpoint call, store reset, full page navigation", async () => {
    mountMenu();
    const auth = applyUser();
    await nextTick();
    await openMenu();

    (document.querySelector("[data-user-menu-logout]") as HTMLElement).click();
    await vi.waitFor(() => expect(document.querySelector("[data-user-menu-logout-confirm]")).not.toBeNull());

    (document.querySelector("[data-user-menu-logout-confirm]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));

    expect(webAuthMocks.logout).toHaveBeenCalledTimes(1);
    expect(auth.authenticated).toBe(false);
    expect(auth.user).toBeNull();
  });

  it("still navigates to the login page when the logout endpoint fails", async () => {
    webAuthMocks.logout.mockRejectedValue(new Error("network down"));
    mountMenu();
    const auth = applyUser();
    await nextTick();
    await openMenu();

    (document.querySelector("[data-user-menu-logout]") as HTMLElement).click();
    await vi.waitFor(() => expect(document.querySelector("[data-user-menu-logout-confirm]")).not.toBeNull());
    (document.querySelector("[data-user-menu-logout-confirm]") as HTMLButtonElement).click();

    await vi.waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
    expect(auth.authenticated).toBe(false);
  });
});
