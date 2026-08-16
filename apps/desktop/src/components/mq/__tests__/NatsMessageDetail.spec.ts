// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) }),
}));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/backend/errorUtils", () => ({ formatError: (cause: unknown) => String(cause) }));

import NatsMessageDetail from "@/components/mq/nats/NatsMessageDetail.vue";
import type { NatsMessage } from "@/types/nats";

const JSON_MESSAGE: NatsMessage = {
  subject: "orders.created",
  headers: [{ key: "Nats-Msg-Id", value: "1" }],
  payloadBase64: "eyJhIjoxfQ==",
  payloadText: '{"a":1}',
  receivedAtMs: 0,
  sizeBytes: 7,
};

let app: App | undefined;

function mount(props: Record<string, unknown>): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  app = createApp(NatsMessageDetail, props);
  app.mount(host);
  return host;
}

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
});

describe("NatsMessageDetail master/detail pane", () => {
  it("shows a placeholder when no message is selected", () => {
    const host = mount({ message: undefined });
    expect(host.textContent).toContain("nats.messages.detailPlaceholder");
  });

  it("renders JSON by default and switches format on tab click", async () => {
    const host = mount({ message: JSON_MESSAGE });
    // Auto → pretty-printed JSON, headers table populated.
    expect(host.querySelector(".detail-payload-body")?.textContent).toContain('"a": 1');
    expect(host.querySelector(".headers-table")?.textContent).toContain("Nats-Msg-Id");

    const textTab = Array.from(host.querySelectorAll<HTMLButtonElement>(".mode-tab")).find((b) => b.textContent?.includes("mode.text"));
    expect(textTab).toBeTruthy();
    textTab!.click();
    await nextTick();
    // Raw text mode shows the un-prettified payload.
    expect(host.querySelector(".detail-payload-body")?.textContent).toBe('{"a":1}');
  });
});
