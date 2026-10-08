// @vitest-environment happy-dom

import { createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
// Mirrors the real translator: known auth error codes map to a message key,
// unmapped codes come back unchanged so the component falls back to a generic
// login-failed message.
vi.mock("@/i18n/backend-errors", () => {
  const knownAuthErrors = new Set(["invalid_credentials", "user_disabled", "blacklisted", "rate_limited", "weak_password", "already_initialized"]);
  return { translateBackendError: (_t: unknown, message: string) => (knownAuthErrors.has(message) ? `translated:${message}` : message) };
});

import LoginPage from "@/components/auth/LoginPage.vue";
import type { StartupAuthentication } from "@/lib/startup/startupAuthentication";

const loginSuccess: StartupAuthentication = {
  required: true,
  authenticated: true,
  setup_required: false,
  user: { username: "ops.user", display_name: null, is_admin: false, department_name: null, roles: [] },
  permissions: ["query.read"],
  must_change_password: false,
  password_expires_in_days: 90,
};

let root: HTMLDivElement;
let mountedApp: ReturnType<typeof createApp> | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const authenticatedEvents: StartupAuthentication[] = [];

function mountLoginPage(setupMode = false) {
  mountedApp = createApp({
    render: () => h(LoginPage, { setupMode, onAuthenticated: (payload: StartupAuthentication) => authenticatedEvents.push(payload) }),
  });
  mountedApp.config.errorHandler = vi.fn();
  mountedApp.mount(root);
}

function form(): HTMLFormElement {
  return root.querySelector("form")!;
}

function usernameInput(): HTMLInputElement {
  return root.querySelector<HTMLInputElement>("[data-username-input]")!;
}

function passwordInputs(): HTMLInputElement[] {
  return [...root.querySelectorAll<HTMLInputElement>("input[type='password']")];
}

function submitButton(): HTMLButtonElement {
  return [...form().querySelectorAll("button")].reverse().find((button) => button.type === "submit")!;
}

function setInputValue(element: HTMLInputElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  authenticatedEvents.length = 0;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = undefined;
  root.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LoginPage username form", () => {
  it("renders username and password fields in login mode", () => {
    mountLoginPage();
    expect(usernameInput()).not.toBeNull();
    expect(passwordInputs()).toHaveLength(1);
    expect(root.textContent).toContain("auth.loginDescription");
    expect(root.textContent).toContain("auth.login");
  });

  it("lowercases the username as the user types", async () => {
    mountLoginPage();
    setInputValue(usernameInput(), "Ops.User-1");
    await nextTick();
    await nextTick();
    expect(usernameInput().value).toBe("ops.user-1");
  });

  it("disables submission and explains while the username is invalid", async () => {
    mountLoginPage();
    setInputValue(usernameInput(), "ab");
    setInputValue(passwordInputs()[0], "secret");
    await nextTick();
    expect(submitButton().disabled).toBe(true);
    expect(root.querySelector("[data-username-invalid]")?.textContent).toBe("auth.usernameInvalid");

    setInputValue(usernameInput(), "ops.user");
    await nextTick();
    expect(submitButton().disabled).toBe(false);
    expect(root.querySelector("[data-username-invalid]")).toBeNull();
  });

  it("sends {username, password} to the login endpoint and emits the payload", async () => {
    fetchMock.mockResolvedValue(jsonResponse(loginSuccess));
    mountLoginPage();
    setInputValue(usernameInput(), "ops.user");
    setInputValue(passwordInputs()[0], "secret");
    await nextTick();
    submitButton().click();
    await vi.waitFor(() => expect(authenticatedEvents).toEqual([loginSuccess]));

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username: "ops.user", password: "secret" }),
    });
  });

  it.each([
    ["invalid_credentials", 401],
    ["user_disabled", 401],
    ["blacklisted", 403],
    ["rate_limited", 429],
    ["weak_password", 400],
  ])("translates the %s error code from the login endpoint", async (code, status) => {
    fetchMock.mockResolvedValue(jsonResponse({ error: code }, status));
    mountLoginPage();
    setInputValue(usernameInput(), "ops.user");
    setInputValue(passwordInputs()[0], "wrong");
    await nextTick();
    submitButton().click();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toBe(`translated:${code}`));
    expect(authenticatedEvents).toHaveLength(0);
  });

  it("falls back to the generic message when the code is unmapped", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "teapot" }, 418));
    mountLoginPage();
    setInputValue(usernameInput(), "ops.user");
    setInputValue(passwordInputs()[0], "wrong");
    await nextTick();
    submitButton().click();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toBe("auth.loginFailed"));
  });
});

describe("LoginPage setup mode", () => {
  it("renders username, password and confirmation fields with admin wording", () => {
    mountLoginPage(true);
    expect(usernameInput()).not.toBeNull();
    expect(passwordInputs()).toHaveLength(2);
    expect(root.textContent).toContain("auth.setupTitle");
    expect(root.textContent).toContain("auth.setupDescription");
    expect(submitButton().textContent).toContain("auth.setPassword");
  });

  it("keeps submission disabled until the passwords match", async () => {
    mountLoginPage(true);
    setInputValue(usernameInput(), "admin");
    setInputValue(passwordInputs()[0], "first-secret");
    await nextTick();
    expect(submitButton().disabled).toBe(true);

    setInputValue(passwordInputs()[1], "second-secret");
    await nextTick();
    expect(submitButton().disabled).toBe(true);

    setInputValue(passwordInputs()[1], "first-secret");
    await nextTick();
    expect(submitButton().disabled).toBe(false);
  });

  it("sends {username, password} to the setup endpoint and emits the payload", async () => {
    fetchMock.mockResolvedValue(jsonResponse(loginSuccess));
    mountLoginPage(true);
    setInputValue(usernameInput(), "admin");
    setInputValue(passwordInputs()[0], "first-secret");
    setInputValue(passwordInputs()[1], "first-secret");
    await nextTick();
    submitButton().click();
    await vi.waitFor(() => expect(authenticatedEvents).toEqual([loginSuccess]));

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username: "admin", password: "first-secret" }),
    });
  });

  it("translates already_initialized from the setup endpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "already_initialized" }, 409));
    mountLoginPage(true);
    setInputValue(usernameInput(), "admin");
    setInputValue(passwordInputs()[0], "first-secret");
    setInputValue(passwordInputs()[1], "first-secret");
    await nextTick();
    submitButton().click();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toBe("translated:already_initialized"));
  });
});
