// @vitest-environment happy-dom

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ desktop: vi.fn() }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: mocks.desktop }));

import { useAuthStore } from "@/stores/authStore";
import { PERMISSION_KEYS } from "@/lib/auth/permissions";

const authenticatedPayload = {
  required: true,
  authenticated: true,
  setup_required: false,
  user: {
    username: "ops.user",
    display_name: "Ops User",
    is_admin: false,
    department_name: "Platform",
    roles: ["db_readonly"],
  },
  permissions: ["query.read", "export.data"],
  must_change_password: true,
  password_expires_in_days: 3,
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
});

describe("authStore", () => {
  it("maps a full auth-check payload onto the store state", () => {
    mocks.desktop.mockReturnValue(false);
    const auth = useAuthStore();

    auth.applyCheckResponse(authenticatedPayload);

    expect(auth.authenticated).toBe(true);
    expect(auth.user).toEqual(authenticatedPayload.user);
    expect(auth.isAdmin).toBe(false);
    expect(auth.permissions).toEqual(["query.read", "export.data"]);
    expect(auth.mustChangePassword).toBe(true);
    expect(auth.passwordExpiresInDays).toBe(3);
    expect(auth.loaded).toBe(true);
  });

  it("treats a missing user as unauthenticated admin-free state", () => {
    mocks.desktop.mockReturnValue(false);
    const auth = useAuthStore();

    auth.applyCheckResponse({
      required: true,
      authenticated: false,
      setup_required: false,
      user: null,
      permissions: [],
      must_change_password: false,
      password_expires_in_days: null,
    });

    expect(auth.authenticated).toBe(false);
    expect(auth.user).toBeNull();
    expect(auth.isAdmin).toBe(false);
    expect(auth.mustChangePassword).toBe(false);
    expect(auth.passwordExpiresInDays).toBeNull();
  });

  it("grants permission checks from the permission list and short-circuits for admins", () => {
    mocks.desktop.mockReturnValue(false);
    const auth = useAuthStore();

    auth.applyCheckResponse(authenticatedPayload);
    expect(auth.hasPermission("query.read")).toBe(true);
    expect(auth.hasPermission("query.write")).toBe(false);

    auth.applyCheckResponse({ ...authenticatedPayload, user: { ...authenticatedPayload.user, is_admin: true } });
    expect(auth.hasPermission("query.write")).toBe(true);
    expect(auth.hasPermission(PERMISSION_KEYS[PERMISSION_KEYS.length - 1])).toBe(true);
  });

  it("reset() clears the web session", () => {
    mocks.desktop.mockReturnValue(false);
    const auth = useAuthStore();
    auth.applyCheckResponse(authenticatedPayload);

    auth.reset();

    expect(auth.authenticated).toBe(false);
    expect(auth.user).toBeNull();
    expect(auth.permissions).toEqual([]);
    expect(auth.isAdmin).toBe(false);
    expect(auth.mustChangePassword).toBe(false);
    expect(auth.passwordExpiresInDays).toBeNull();
    expect(auth.loaded).toBe(false);
  });

  it("bypasses authentication on the desktop (admin with every permission)", () => {
    mocks.desktop.mockReturnValue(true);
    const auth = useAuthStore();

    expect(auth.authenticated).toBe(true);
    expect(auth.isAdmin).toBe(true);
    expect(auth.permissions).toEqual([...PERMISSION_KEYS]);
    expect(auth.loaded).toBe(true);
    expect(auth.mustChangePassword).toBe(false);
    for (const key of PERMISSION_KEYS) expect(auth.hasPermission(key)).toBe(true);
    expect(auth.hasPermission("unknown.permission")).toBe(true);
  });

  it("reset() restores the desktop bypass instead of logging the desktop out", () => {
    mocks.desktop.mockReturnValue(true);
    const auth = useAuthStore();

    auth.reset();

    expect(auth.authenticated).toBe(true);
    expect(auth.isAdmin).toBe(true);
    expect(auth.permissions).toEqual([...PERMISSION_KEYS]);
  });
});
