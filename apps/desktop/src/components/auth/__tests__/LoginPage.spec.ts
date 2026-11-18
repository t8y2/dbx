// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
// The logo reads the settings store; the login form does not, so stub it rather
// than booting pinia for a component that renders nothing here.
vi.mock("@/components/icons/AppLogo.vue", () => ({ default: { name: "AppLogo", render: () => null } }));

import LoginPage from "../LoginPage.vue";

const CAPTCHA_BODY = { id: "challenge-1", image: "data:image/png;base64,AAAA", expires_in: 300 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mount(): { root: HTMLElement; app: App } {
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(LoginPage);
  app.mount(root);
  return { root, app };
}

// fetch + Response.json both resolve on later microtasks than nextTick, so
// drain a few turns before asserting on the rendered result.
async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

function typeInto(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

describe("LoginPage captcha", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/auth/captcha")) return jsonResponse(CAPTCHA_BODY);
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("loads a challenge on mount and renders its image", async () => {
    const { root, app } = mount();
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/auth/captcha"), expect.anything());
    const image = root.querySelector<HTMLImageElement>('[data-testid="captcha-image"]');
    expect(image?.getAttribute("src")).toBe(CAPTCHA_BODY.image);
    app.unmount();
  });

  it("sends the challenge id and the typed code with the password", async () => {
    const { root, app } = mount();
    await flush();

    typeInto(root.querySelector<HTMLInputElement>('[data-testid="captcha-input"]')!, "abcde");
    const passwordInput = root.querySelector<HTMLInputElement>('input[type="password"]')!;
    typeInto(passwordInput, "secret");
    await nextTick();

    root.querySelector("form")!.dispatchEvent(new Event("submit"));
    await flush();

    const loginCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/auth/login"));
    expect(loginCall).toBeTruthy();
    const body = JSON.parse(String((loginCall![1] as RequestInit).body));
    expect(body).toEqual({ password: "secret", captcha_id: "challenge-1", captcha_code: "abcde" });
    app.unmount();
  });

  it("refreshes the challenge after a rejected attempt", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/auth/captcha")) return jsonResponse({ ...CAPTCHA_BODY, id: `challenge-${fetchMock.mock.calls.length}` });
      return jsonResponse({ error: "captcha_invalid" }, 400);
    });
    const { root, app } = mount();
    await flush();

    typeInto(root.querySelector<HTMLInputElement>('[data-testid="captcha-input"]')!, "zzzzz");
    typeInto(root.querySelector<HTMLInputElement>('input[type="password"]')!, "secret");
    await nextTick();
    root.querySelector("form")!.dispatchEvent(new Event("submit"));
    await flush();

    const captchaCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/auth/captcha"));
    expect(captchaCalls.length).toBeGreaterThanOrEqual(2);
    // The consumed challenge is replaced and the input cleared.
    expect(root.querySelector<HTMLInputElement>('[data-testid="captcha-input"]')!.value).toBe("");
    app.unmount();
  });

  it("hides the challenge when the server answers 204 and logs in without one", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/auth/captcha")) return new Response(null, { status: 204 });
      return jsonResponse({ ok: true });
    });
    const { root, app } = mount();
    await flush();

    expect(root.querySelector('[data-testid="captcha-input"]')).toBeNull();
    typeInto(root.querySelector<HTMLInputElement>('input[type="password"]')!, "secret");
    await nextTick();
    // Without a challenge on screen the submit button must not wait for one.
    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    root.querySelector("form")!.dispatchEvent(new Event("submit"));
    await flush();

    const loginCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/auth/login"));
    expect(loginCall, JSON.stringify(fetchMock.mock.calls.map(([url]) => String(url)))).toBeTruthy();
    expect(JSON.parse(String((loginCall![1] as RequestInit).body))).toEqual({ password: "secret" });
    app.unmount();
  });

  it("reveals the challenge after a failed attempt when the mode is auto", async () => {
    let attempts = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/auth/captcha")) {
        // auto: no challenge until the first failure
        return attempts === 0 ? new Response(null, { status: 204 }) : jsonResponse(CAPTCHA_BODY);
      }
      attempts += 1;
      return jsonResponse({ error: "invalid_password" }, 401);
    });
    const { root, app } = mount();
    await flush();
    expect(root.querySelector('[data-testid="captcha-input"]')).toBeNull();

    typeInto(root.querySelector<HTMLInputElement>('input[type="password"]')!, "wrong");
    await nextTick();
    root.querySelector("form")!.dispatchEvent(new Event("submit"));
    await flush();

    expect(root.querySelector('[data-testid="captcha-input"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="captcha-image"]')?.getAttribute("src")).toBe(CAPTCHA_BODY.image);
    app.unmount();
  });

  it("does not request a challenge while setting up the first password", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(LoginPage, { setupMode: true });
    app.mount(root);
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(root.querySelector('[data-testid="captcha-input"]')).toBeNull();
    app.unmount();
  });
});
