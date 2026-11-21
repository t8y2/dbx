// @vitest-environment happy-dom
import { createApp, h, reactive } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, expect, it, vi } from "vitest";
import KafkaBrokerConfigDialog from "../KafkaBrokerConfigDialog.vue";
import en from "@/i18n/locales/en";
import type { KafkaBrokerConfig } from "@/types/mq";

const fetchConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/backend/api", () => ({ mqGetBrokerConfig: fetchConfig }));
const entry = (value: string, isSensitive = false) => ({ value, source: "STATIC_BROKER_CONFIG", isSensitive, isReadOnly: true, isDefault: false });
const unmount: Array<() => void> = [];
afterEach(() => {
  unmount.splice(0).forEach((cleanup) => cleanup());
  fetchConfig.mockReset();
});

function mount() {
  const props = reactive({ connectionId: "session-a", brokerId: null as number | null });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(KafkaBrokerConfigDialog, props) });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en } }));
  app.mount(host);
  unmount.push(() => {
    app.unmount();
    host.remove();
  });
  return props;
}

it("loads only an opened broker and filters names without rendering sensitive values", async () => {
  const props = mount();
  expect(fetchConfig).not.toHaveBeenCalled();
  fetchConfig.mockResolvedValue({ configs: { "ssl.keystore.password": entry("not for display", true), "num.partitions": entry("4") } });
  props.brokerId = 0;
  await vi.waitFor(() => expect(document.body.textContent).toContain("num.partitions"));
  expect(fetchConfig).toHaveBeenCalledExactlyOnceWith("session-a", 0);
  expect(document.body.textContent).toContain("ssl.keystore.password");
  expect(document.body.textContent).not.toContain("not for display");
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  input.value = "partitions";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain("ssl.keystore.password"));
});

it("keeps the selected broker's result when an earlier request finishes later", async () => {
  let finish!: (response: KafkaBrokerConfig) => void;
  fetchConfig.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  fetchConfig.mockResolvedValueOnce({ configs: { current: entry("visible") } });
  const props = mount();
  props.brokerId = 1;
  await vi.waitFor(() => expect(fetchConfig).toHaveBeenCalledWith("session-a", 1));
  props.brokerId = 2;
  await vi.waitFor(() => expect(document.body.textContent).toContain("current"));
  finish({ configs: { stale: entry("old broker") } });
  await Promise.resolve();
  expect(document.body.textContent).not.toContain("old broker");
});

it("shows an unsupported status for legacy brokers and clears it when switching brokers", async () => {
  fetchConfig.mockResolvedValueOnce({ configs: {}, configSupported: false, unsupportedReason: "DescribeConfigs is not supported" });
  fetchConfig.mockResolvedValueOnce({ configs: { "num.partitions": entry("4") } });
  const props = mount();
  props.brokerId = 1;
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"] [role="status"]')?.textContent).toContain(en.mqBroker.configurationUnsupported));
  expect(document.body.textContent).toContain("DescribeConfigs is not supported");
  expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
  expect(document.body.textContent).not.toContain(en.mqBroker.noConfigurations);

  props.brokerId = 2;
  await vi.waitFor(() => expect(document.body.textContent).toContain("num.partitions"));
  expect(document.body.textContent).not.toContain(en.mqBroker.configurationUnsupported);
});

it.each(["permission denied", "network disconnected", "request timed out"])("shows an ordinary error for %s", async (message) => {
  fetchConfig.mockRejectedValueOnce(new Error(message));
  const props = mount();
  props.brokerId = 0;
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(message));
  expect(document.body.textContent).not.toContain(en.mqBroker.configurationUnsupported);
});
