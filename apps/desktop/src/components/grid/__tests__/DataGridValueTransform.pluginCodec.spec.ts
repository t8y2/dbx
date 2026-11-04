// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type Ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@/types/database";
import type { PluginDecodeRequest } from "@/lib/dataGrid/sqlPluginCodec";

const backend = vi.hoisted(() => ({
  plugins: [] as unknown[],
  listPlugins: vi.fn(),
  invokePlugin: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params?.message ? `${key}:${params.message}` : key) }),
}));
vi.mock("@/components/ui/button", () => ({
  Button: defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h("button", attrs, slots.default?.());
    },
  }),
}));
vi.mock("@/lib/backend/api", () => ({ listPlugins: backend.listPlugins, invokePlugin: backend.invokePlugin }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: vi.fn() }));

import DataGridValueTransform from "@/components/grid/DataGridValueTransform.vue";

function codecPlugin(id = "acme.decrypt"): InstalledPlugin {
  return {
    manifest: { id, name: "Acme", entrypoints: { backend: { executable: "bin" } }, capabilities: [{ id: "func", label: "Function source", kind: "sql-value-codec-v1" }] },
    compatibility: { compatible: true },
  } as unknown as InstalledPlugin;
}

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement | undefined;

beforeEach(() => {
  backend.plugins = [];
  backend.listPlugins.mockReset().mockImplementation(async () => backend.plugins);
  backend.invokePlugin.mockReset();
});

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
});

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

interface MountProps {
  source: string | null;
  identity?: string;
  columnType?: string;
  pluginOnly?: boolean;
  pluginDecodeRequest?: PluginDecodeRequest | null;
}

async function mount(initial: MountProps): Promise<Ref<MountProps>> {
  const state = ref<MountProps>({ identity: "1:0", ...initial });
  const open = ref(false);
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(DataGridValueTransform, {
            ...state.value,
            identity: state.value.identity ?? "1:0",
            column: "SOURCE",
            databaseType: "oracle",
            open: open.value,
            "onUpdate:open": (value: boolean) => (open.value = value),
          });
      },
    }),
  );
  app.mount(root);
  await flush();
  return state;
}

function button(label: string): HTMLButtonElement | undefined {
  return [...root!.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
}

async function choose(selector: string, value: string) {
  const select = root!.querySelector<HTMLSelectElement>(selector)!;
  select.value = value;
  select.dispatchEvent(new Event("change"));
  await flush();
}

async function openPluginKind() {
  button("cellTransform.title")!.click();
  await flush();
  await choose("[data-cell-transform-kind]", "plugin");
}

function resultText(): string | undefined {
  return root!.querySelector<HTMLTextAreaElement>('textarea[aria-label="cellTransform.result"]')?.value;
}

describe("DataGridValueTransform plugin decoding", () => {
  it("does not offer plugin decoding until a SQL codec plugin is installed", async () => {
    await mount({ source: "cipher" });
    button("cellTransform.title")!.click();
    await flush();
    expect(root!.querySelector('[data-cell-transform-kind] option[value="plugin"]')).toBeNull();
    expect(backend.invokePlugin).not.toHaveBeenCalled();
  });

  it("sends only this cell's bytes and column facts on an explicit convert", async () => {
    backend.plugins = [codecPlugin()];
    backend.invokePlugin.mockResolvedValue({ format: "text", value: "function f() {\n  return 1;\n}" });
    await mount({ source: "中", columnType: "CLOB" });
    await openPluginKind();
    expect(backend.invokePlugin).not.toHaveBeenCalled();

    button("cellTransform.convert")!.click();
    await flush();
    expect(backend.invokePlugin).toHaveBeenCalledWith("acme.decrypt", "sql/codec/decode", { codecId: "func", rawBase64: "5Lit", context: { dbType: "oracle", columnName: "SOURCE", columnType: "CLOB" } }, 10_000);
    expect(resultText()).toBe("function f() {\n  return 1;\n}");
  });

  it("shows the plugin error instead of a result", async () => {
    backend.plugins = [codecPlugin()];
    backend.invokePlugin.mockRejectedValue(new Error("bad key"));
    await mount({ source: "cipher" });
    await openPluginKind();
    button("cellTransform.convert")!.click();
    await flush();
    expect(root!.querySelector('[role="alert"]')?.textContent).toBe("cellTransform.errors.pluginFailed:bad key");
    expect(resultText()).toBeUndefined();
  });

  it("makes the user choose when several codecs are installed", async () => {
    backend.plugins = [codecPlugin("a.decrypt"), codecPlugin("b.decrypt")];
    await mount({ source: "cipher" });
    await openPluginKind();
    expect(button("cellTransform.convert")!.disabled).toBe(true);
    await choose("[data-cell-transform-plugin-codec]", JSON.stringify(["b.decrypt", "func"]));
    expect(button("cellTransform.convert")!.disabled).toBe(false);
  });

  it("drops a response that arrives after the cell changed", async () => {
    backend.plugins = [codecPlugin()];
    let resolve!: (value: unknown) => void;
    backend.invokePlugin.mockReturnValue(new Promise((done) => (resolve = done)));
    const state = await mount({ source: "first" });
    await openPluginKind();
    button("cellTransform.convert")!.click();
    await flush();
    state.value = { ...state.value, source: "second" };
    await flush();
    resolve({ format: "text", value: "first plaintext" });
    await flush();
    expect(resultText()).toBeUndefined();
  });

  it("decodes the original bytes of a binary cell in plugin-only mode", async () => {
    backend.plugins = [codecPlugin()];
    backend.invokePlugin.mockResolvedValue({ format: "json", value: { ok: true } });
    await mount({ source: "0x00ff80", columnType: "BLOB", pluginOnly: true });
    button("cellTransform.kinds.plugin")!.click();
    await flush();
    expect([...root!.querySelectorAll("[data-cell-transform-kind] option")].map((option) => option.getAttribute("value"))).toEqual(["plugin"]);
    button("cellTransform.convert")!.click();
    await flush();
    expect(backend.invokePlugin.mock.calls[0][2]).toMatchObject({ rawBase64: "AP+A" });
    expect(resultText()).toBe('{\n  "ok": true\n}');
  });

  it("renders nothing in plugin-only mode without a codec", async () => {
    await mount({ source: "0x00", columnType: "BLOB", pluginOnly: true });
    expect(root!.querySelector("button")).toBeNull();
  });

  it("opens on plugin decoding for the cell the context menu targeted", async () => {
    backend.plugins = [codecPlugin()];
    await mount({ source: "cipher", identity: "1:0", pluginDecodeRequest: { id: 1, identity: "2:0" } });
    expect(root!.querySelector("[data-cell-transform-kind]")).toBeNull();

    app?.unmount();
    root?.remove();
    await mount({ source: "cipher", identity: "1:0", pluginDecodeRequest: { id: 2, identity: "1:0" } });
    expect(root!.querySelector<HTMLSelectElement>("[data-cell-transform-kind]")?.value).toBe("plugin");
  });
});
