// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import PluginOpenUrlDialog from "./PluginOpenUrlDialog.vue";
const shell = vi.hoisted(() => ({ open: vi.fn(), native: false }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => shell.native }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: shell.open }));
let app: App;
let host: HTMLElement;
afterEach(() => {
  app?.unmount();
  host?.remove();
  vi.clearAllMocks();
  shell.native = false;
});
async function mount() {
  const props = reactive({ pluginId: "bookmarks", pluginName: "Bookmarks", permissions: ["host.openUrl:https://example.com"] });
  let dialog!: InstanceType<typeof PluginOpenUrlDialog>;
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({
    render: () =>
      h(PluginOpenUrlDialog, {
        ...props,
        ref: (value) => {
          dialog = value as typeof dialog;
        },
      }),
  });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: { pluginPlatform: { openUrlTitle: "Open external URL", openUrlPrompt: "Plugin {name} wants to open this URL." }, common: { cancel: "Cancel" }, grid: { openUrl: "Open in browser" } } } }));
  app.mount(host);
  await nextTick();
  return { props, dialog };
}
describe("PluginOpenUrlDialog", () => {
  it("shows host-owned identity and full destination; cancel and unmount never navigate", async () => {
    const { dialog } = await mount();
    const decision = dialog.request("https://example.com/path?q=visible");
    await nextTick();
    expect(document.body.textContent).toContain("Plugin Bookmarks");
    expect(document.body.textContent).toContain("https://example.com/path?q=visible");
    const link = document.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
    expect(link.rel).toBe("noopener noreferrer");
    expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
    await expect(dialog.request("https://example.com/second")).rejects.toThrow("already awaiting");
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
    await expect(decision).resolves.toEqual({ opened: false });
    expect(shell.open).not.toHaveBeenCalled();
    const pending = dialog.request("https://example.com/again");
    app.unmount();
    await expect(pending).resolves.toEqual({ opened: false });
  });
  it("does not call the native shell until explicit approval and keeps failures retryable", async () => {
    shell.native = true;
    shell.open.mockRejectedValueOnce(new Error("Browser unavailable")).mockResolvedValueOnce(undefined);
    const { dialog } = await mount();
    const result = dialog.request("https://example.com/path");
    await nextTick();
    expect(shell.open).not.toHaveBeenCalled();
    document.querySelector<HTMLAnchorElement>('a[target="_blank"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe("Browser unavailable"));
    document.querySelector<HTMLAnchorElement>('a[target="_blank"]')!.click();
    await expect(result).resolves.toEqual({ opened: true });
    expect(shell.open).toHaveBeenCalledTimes(2);
    expect(shell.open).toHaveBeenLastCalledWith("https://example.com/path");
  });
  it("cancels pending consent when plugin identity or permissions change", async () => {
    const { dialog, props } = await mount();
    const result = dialog.request("https://example.com/path");
    props.permissions = [];
    await nextTick();
    await expect(result).resolves.toEqual({ opened: false });
    expect(() => dialog.request("https://example.com/path")).toThrow("not declared");
  });
  it("does not let a late native opening settle a subsequent request", async () => {
    shell.native = true;
    let finish!: () => void;
    shell.open.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { dialog } = await mount();
    const first = dialog.request("https://example.com/first");
    await nextTick();
    document.querySelector<HTMLAnchorElement>('a[target="_blank"]')!.click();
    await vi.waitFor(() => expect(shell.open).toHaveBeenCalled());
    dialog.cancel();
    await expect(first).resolves.toEqual({ opened: false });
    await expect(dialog.request("https://example.com/second")).rejects.toThrow("already awaiting");
    finish();
    await nextTick();
    await nextTick();
    const second = dialog.request("https://example.com/second");
    await nextTick();
    expect(document.body.textContent).toContain("https://example.com/second");
    dialog.cancel();
    await expect(second).resolves.toEqual({ opened: false });
  });
});
