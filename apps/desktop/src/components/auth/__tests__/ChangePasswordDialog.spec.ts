// @vitest-environment happy-dom

import { createApp, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n/backend-errors", () => ({ translateBackendError: (_t: unknown, message: string) => `translated:${message}` }));

import ChangePasswordDialog from "@/components/auth/ChangePasswordDialog.vue";
import { useAuthStore } from "@/stores/authStore";
import { useToast } from "@/composables/useToast";

let root: HTMLDivElement;
let mountedApp: ReturnType<typeof createApp> | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const closeEvents: unknown[] = [];
const changedEvents: unknown[] = [];

function mountDialog(mode: "forced" | "voluntary") {
  mountedApp = createApp({
    render: () => h(ChangePasswordDialog, { mode, onClose: () => closeEvents.push("close"), onChanged: () => changedEvents.push("changed") }),
  });
  mountedApp.use(createPinia());
  mountedApp.config.errorHandler = vi.fn();
  mountedApp.mount(root);
}

function dialogRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-change-password-dialog]");
}

function passwordField(selector: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(selector)!;
}

function submitButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-change-password-submit]");
}

function cancelButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-change-password-cancel]");
}

function setInputValue(element: HTMLInputElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function fillPasswords(oldValue: string, newValue: string, confirmValue: string) {
  setInputValue(passwordField("[data-old-password]"), oldValue);
  setInputValue(passwordField("[data-new-password]"), newValue);
  setInputValue(passwordField("[data-confirm-password]"), confirmValue);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  closeEvents.length = 0;
  changedEvents.length = 0;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  globalThis.__DBX_TOAST_STATE__ = undefined;
});

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = undefined;
  root.remove();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChangePasswordDialog", () => {
  it("renders the three password fields", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    mountDialog("voluntary");
    await vi.waitFor(() => expect(dialogRoot()).not.toBeNull());

    expect(passwordField("[data-old-password]")).not.toBeNull();
    expect(passwordField("[data-new-password]")).not.toBeNull();
    expect(passwordField("[data-confirm-password]")).not.toBeNull();
  });

  it("requires a 6+ character new password and matching confirmation before submitting", async () => {
    mountDialog("voluntary");
    await vi.waitFor(() => expect(dialogRoot()).not.toBeNull());

    fillPasswords("old-pass", "12345", "12345");
    await nextTick();
    expect(submitButton()!.disabled).toBe(true);

    setInputValue(passwordField("[data-new-password]"), "new-secret");
    await nextTick();
    expect(submitButton()!.disabled).toBe(true);

    setInputValue(passwordField("[data-confirm-password]"), "new-secret");
    await nextTick();
    expect(submitButton()!.disabled).toBe(false);
  });

  it("posts {old_password, new_password} and updates the auth store + toast on success", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    mountDialog("forced");
    await vi.waitFor(() => expect(dialogRoot()).not.toBeNull());

    const auth = useAuthStore();
    auth.mustChangePassword = true;
    auth.passwordExpiresInDays = 0;

    fillPasswords("old-pass", "new-secret", "new-secret");
    await nextTick();
    submitButton()!.click();

    await vi.waitFor(() => expect(changedEvents).toEqual(["changed"]));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ old_password: "old-pass", new_password: "new-secret" }),
    });
    expect(auth.mustChangePassword).toBe(false);
    expect(auth.passwordExpiresInDays).toBe(90);

    const { message, visible } = useToast();
    expect(visible.value).toBe(true);
    expect(message.value).toBe("auth.passwordChanged");
  });

  it("translates an invalid old password failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "invalid_credentials" }, 401));
    mountDialog("voluntary");
    await vi.waitFor(() => expect(dialogRoot()).not.toBeNull());

    fillPasswords("wrong", "new-secret", "new-secret");
    await nextTick();
    submitButton()!.click();

    await vi.waitFor(() => expect(dialogRoot()!.querySelector('[role="alert"]')?.textContent).toBe("translated:invalid_credentials"));
    expect(changedEvents).toHaveLength(0);
  });

  it("translates a weak new password failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "weak_password" }, 400));
    mountDialog("forced");
    await vi.waitFor(() => expect(dialogRoot()).not.toBeNull());

    fillPasswords("old-pass", "weak-password", "weak-password");
    await nextTick();
    submitButton()!.click();

    await vi.waitFor(() => expect(dialogRoot()!.querySelector('[role="alert"]')?.textContent).toBe("translated:weak_password"));
  });

  it("offers a cancel button and emits close in voluntary mode", async () => {
    mountDialog("voluntary");
    await vi.waitFor(() => expect(dialogRoot()).not.toBeNull());

    expect(cancelButton()).not.toBeNull();
    cancelButton()!.click();
    await nextTick();
    expect(closeEvents).toEqual(["close"]);
  });

  it("forced mode has no cancel button and no close affordance", async () => {
    mountDialog("forced");
    await vi.waitFor(() => expect(dialogRoot()).not.toBeNull());

    expect(cancelButton()).toBeNull();
    // The dialog-content close button is disabled via showCloseButton=false.
    expect(dialogRoot()!.querySelector("[data-slot='dialog-close']")).toBeNull();
    // No header X button either — the only way out is a successful change.
    const buttons = [...dialogRoot()!.querySelectorAll("button")];
    expect(buttons.filter((button) => button.textContent?.trim() === "Close" || button.textContent?.trim() === "×")).toHaveLength(0);
  });

  it("forced mode swallows dialog dismissal requests instead of emitting close", async () => {
    mountDialog("forced");
    await vi.waitFor(() => expect(dialogRoot()).not.toBeNull());

    // Escape key and outside pointer interactions are intercepted with
    // .prevent handlers on DialogContent; simulate the underlying reka-ui
    // open-request path via a keydown Escape on the dialog.
    dialogRoot()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(closeEvents).toHaveLength(0);
    expect(dialogRoot()).not.toBeNull();
  });
});
