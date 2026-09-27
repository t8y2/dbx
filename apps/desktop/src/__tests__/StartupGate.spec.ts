// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  desktop: vi.fn(),
  appImported: vi.fn(),
  reloadLocale: vi.fn(),
  migrationStatus: vi.fn(),
  migrationStart: vi.fn(),
  migrationRetry: vi.fn(),
  migrationCleanupBackups: vi.fn(),
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: mocks.desktop }));
vi.mock("@/lib/backend/api", () => mocks);
vi.mock("@/i18n", () => ({ loadSavedLocale: mocks.reloadLocale }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const readyStatus = { state: "not_required", needsMigration: false };
let businessReady: ReturnType<typeof deferred<void>>;
let mountedApp: App | undefined;
let root: HTMLDivElement;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  sessionStorage.clear();
  mocks.desktop.mockReturnValue(true);
  mocks.migrationStatus.mockResolvedValue(readyStatus);
  mocks.reloadLocale.mockResolvedValue(undefined);
  businessReady = deferred<void>();
  root = document.createElement("div");
  document.body.append(root);
  vi.doMock("../App.vue", async () => {
    mocks.appImported();
    await businessReady.promise;
    return {
      __esModule: true,
      default: defineComponent({
        props: ["startupAuthentication"],
        setup: (props) => () => h("main", { "data-business-app": "" }, JSON.stringify(props.startupAuthentication ?? null)),
      }),
    };
  });
  vi.doMock("@/components/auth/LoginPage.vue", () => ({
    __esModule: true,
    default: defineComponent({
      props: ["setupMode"],
      emits: ["authenticated"],
      setup:
        (props, { emit }) =>
        () =>
          h("button", { "data-login": "", onClick: () => emit("authenticated") }, props.setupMode ? "setup" : "login"),
    }),
  }));
  vi.doMock("@/components/migration/SecurityMigrationWizard.vue", () => ({
    __esModule: true,
    default: defineComponent({
      props: ["store"],
      setup: (props) => () =>
        h(
          "button",
          {
            "data-migration": "",
            onClick: async () => {
              await props.store.start();
              props.store.enter();
            },
          },
          "migrate",
        ),
    }),
  }));
});

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = undefined;
  root.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountGate(localeReady?: Promise<void>) {
  const { default: Gate } = await import("../StartupGate.vue");
  mountedApp = createApp(Gate, { localeReady });
  mountedApp.config.errorHandler = vi.fn();
  mountedApp.mount(root);
}

describe("startup boundary", () => {
  it("checks migration while the locale loads and keeps feedback until the app module resolves", async () => {
    const locale = deferred<void>();
    await mountGate(locale.promise);
    await vi.waitFor(() => expect(mocks.migrationStatus).toHaveBeenCalledTimes(1));
    expect(mocks.appImported).not.toHaveBeenCalled();
    expect(root.querySelector("[data-startup-loading]")).not.toBeNull();
    locale.resolve();
    await vi.waitFor(() => expect(mocks.appImported).toHaveBeenCalledTimes(1));
    expect(root.querySelector("[data-startup-loading]")).not.toBeNull();
    expect(root.querySelector("main")).toBeNull();
    businessReady.resolve();
    await vi.waitFor(() => expect(root.querySelector("[data-business-app]")).not.toBeNull());
    expect(root.querySelector("[data-startup-loading]")).toBeNull();
  });

  it("passes the checked Web authentication state without an extra request", async () => {
    mocks.desktop.mockReturnValue(false);
    const authentication = { required: true, authenticated: true, setup_required: false };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => authentication });
    vi.stubGlobal("fetch", fetchMock);
    businessReady.resolve();
    await mountGate();
    await vi.waitFor(() => expect(root.querySelector("main")).not.toBeNull());
    expect(JSON.parse(root.querySelector("main")!.textContent!)).toEqual(authentication);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("does not inspect protected data until login/setup completes (setup=%s)", async (setup) => {
    mocks.desktop.mockReturnValue(false);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ required: true, authenticated: false, setup_required: setup }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ required: true, authenticated: true }) });
    vi.stubGlobal("fetch", fetchMock);
    businessReady.resolve();
    await mountGate();
    await vi.waitFor(() => expect(root.querySelector("[data-login]")).not.toBeNull());
    expect(root.querySelector("[data-login]")!.textContent).toBe(setup ? "setup" : "login");
    expect(mocks.migrationStatus).not.toHaveBeenCalled();
    expect(mocks.appImported).not.toHaveBeenCalled();
    (root.querySelector("[data-login]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(root.querySelector("main")).not.toBeNull());
    expect(mocks.migrationStatus).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not load the business app until a required migration is completed and entered", async () => {
    mocks.migrationStatus.mockResolvedValueOnce({ state: "pending", needsMigration: true }).mockResolvedValue(readyStatus);
    mocks.migrationStart.mockResolvedValue({ state: "succeeded" });
    businessReady.resolve();
    await mountGate();
    await vi.waitFor(() => expect(root.querySelector("[data-migration]")).not.toBeNull());
    expect(mocks.appImported).not.toHaveBeenCalled();
    (root.querySelector("[data-migration]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(root.querySelector("main")).not.toBeNull());
    expect(mocks.migrationStart).toHaveBeenCalledTimes(1);
  });

  it("fails closed on malformed auth and allows retry", async () => {
    mocks.desktop.mockReturnValue(false);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => null })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ required: false, authenticated: false }) });
    vi.stubGlobal("fetch", fetchMock);
    businessReady.resolve();
    await mountGate();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull());
    expect(mocks.migrationStatus).not.toHaveBeenCalled();
    expect(mocks.appImported).not.toHaveBeenCalled();
    root.querySelector("button")!.click();
    await vi.waitFor(() => expect(root.querySelector("main")).not.toBeNull());
  });

  it("retries a failed locale load without rerunning successful security checks", async () => {
    const locale = deferred<void>();
    businessReady.resolve();
    await mountGate(locale.promise);
    locale.reject(new Error("locale download failed"));
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull());
    expect(mocks.appImported).not.toHaveBeenCalled();
    root.querySelector("button")!.click();
    await vi.waitFor(() => expect(root.querySelector("main")).not.toBeNull());
    expect(mocks.reloadLocale).toHaveBeenCalledTimes(1);
    expect(mocks.migrationStatus).toHaveBeenCalledTimes(1);
  });

  it("shows a safe retry state when the app module fails to load", async () => {
    await mountGate();
    await vi.waitFor(() => expect(mocks.appImported).toHaveBeenCalledTimes(1));
    businessReady.reject(new Error("private module URL"));
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull());
    expect(root.textContent).toContain("startup.loadFailed");
    expect(root.textContent).not.toContain("private module URL");
    expect(root.querySelector("button")).not.toBeNull();
  });

  it("cancels pending authentication when the gate unmounts", async () => {
    mocks.desktop.mockReturnValue(false);
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    await mountGate();
    await nextTick();
    const signal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
    mountedApp!.unmount();
    mountedApp = undefined;
    expect(signal.aborted).toBe(true);
    expect(mocks.migrationStatus).not.toHaveBeenCalled();
  });
});
