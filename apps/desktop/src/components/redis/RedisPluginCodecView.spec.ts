// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { createI18n } from "vue-i18n";
import RedisPluginCodecView from "./RedisPluginCodecView.vue";

const mocks = vi.hoisted(() => ({ listPlugins: vi.fn(), invokePlugin: vi.fn() }));
vi.mock("@/lib/backend/api", () => mocks);
vi.mock("@/components/common/JsonTree.vue", () => ({ default: defineComponent({ props: ["value"], setup: (props) => () => h("pre", { "data-json-tree": "" }, JSON.stringify(props.value)) }) }));
vi.mock("@/components/ui/select", () => ({
  Select: defineComponent({
    props: ["modelValue", "disabled"],
    emits: ["update:modelValue"],
    setup:
      (props, { slots, emit }) =>
      () =>
        h("select", { value: props.modelValue, disabled: props.disabled, onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value) }, slots.default?.()),
  }),
  SelectTrigger: defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("option", { value: "" }, slots.default?.()),
  }),
  SelectValue: defineComponent({ props: ["placeholder"], setup: (props) => () => props.placeholder }),
  SelectContent: defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("optgroup", slots.default?.()),
  }),
  SelectItem: defineComponent({
    props: ["value"],
    setup:
      (props, { slots }) =>
      () =>
        h("option", { value: props.value }, slots.default?.()),
  }),
}));

let app: App | undefined;
let root: HTMLDivElement;
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
};
const plugin = { manifest: { id: "test.codec", name: "Test codec", drivers: [], entrypoints: { backend: { executable: "codec" } }, capabilities: [{ id: "custom", label: "Custom", kind: "redis-value-codec-v1" }] }, compatibility: { compatible: true } };
const choose = async () => {
  const select = root.querySelector("select")!;
  select.value = JSON.stringify(["test.codec", "custom"]);
  select.dispatchEvent(new Event("change"));
  await flush();
};

async function mount() {
  mocks.listPlugins.mockResolvedValue([plugin]);
  root = document.createElement("div");
  document.body.appendChild(root);
  const props = reactive({ rawBase64: "AA==", context: { db: 0, keyRaw: "aw==", redisType: "string" } });
  app = createApp({ render: () => h(RedisPluginCodecView, props) });
  app.use(createI18n({ legacy: false, locale: "en", missingWarn: false, fallbackWarn: false, messages: { en: { redis: {} } } }));
  app.mount(root);
  await flush();
  return props;
}
afterEach(() => {
  app?.unmount();
  root?.remove();
  vi.resetAllMocks();
});

describe("RedisPluginCodecView", () => {
  it("waits for selection and renders the selected decoder's JSON", async () => {
    mocks.invokePlugin.mockResolvedValue({ format: "json", value: { name: "Ada" } });
    await mount();
    expect(mocks.invokePlugin).not.toHaveBeenCalled();
    await choose();
    expect(root.querySelector("[data-json-tree]")?.textContent).toBe('{"name":"Ada"}');
  });

  it("discards a late result after the payload changes", async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.invokePlugin
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValue({ format: "text", value: "new value" });
    const props = await mount();
    await choose();
    props.rawBase64 = "AQ==";
    await flush();
    expect(root.textContent).toContain("new value");
    resolveOld({ format: "text", value: "stale value" });
    await flush();
    expect(root.textContent).toContain("new value");
    expect(root.textContent).not.toContain("stale value");
  });

  it("clears previous data on failure and escapes program text", async () => {
    mocks.invokePlugin.mockResolvedValueOnce({ format: "text", value: '<img src=x onerror="alert(1)">' }).mockRejectedValueOnce(new Error("decoder failed"));
    const props = await mount();
    await choose();
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img");
    props.rawBase64 = "AQ==";
    await flush();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("decoder failed");
    expect(root.textContent).not.toContain("<img");
  });
});
