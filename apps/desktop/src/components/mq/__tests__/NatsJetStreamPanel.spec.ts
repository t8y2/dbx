// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const backend = vi.hoisted(() => ({
  natsJetstreamInfo: vi.fn(),
  natsListStreams: vi.fn(),
  natsGetStream: vi.fn(),
  natsFetchHistory: vi.fn(),
  natsListConsumers: vi.fn(),
  natsGetConsumer: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/backend/api", () => backend);
vi.mock("@/lib/backend/errorUtils", () => ({ formatError: (e: unknown) => String(e) }));
vi.mock("@/components/ui/select", async () => (await import("./selectStub")).createSelectStub());
vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      name: "Button",
      setup:
        (_p, { slots }) =>
        () =>
          h("button", slots.default?.()),
    }),
  };
});
vi.mock("@lucide/vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { Copy: defineComponent({ name: "Copy", setup: () => () => h("i") }) };
});
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: vi.fn() }));

import NatsJetStreamPanel from "@/components/mq/nats/NatsJetStreamPanel.vue";

const STREAM = {
  name: "ORDERS",
  subjects: ["orders.>"],
  storage: "file",
  retention: "limits",
  messages: 10,
  bytes: 1000,
  firstSequence: "1",
  lastSequence: "10",
  consumers: 1,
};

const STREAM_TWO = { ...STREAM, name: "PAYMENTS", subjects: ["payments.>"] };

let app: App | undefined;
let host: HTMLElement | undefined;

async function flush() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  app = createApp(NatsJetStreamPanel, { connectionId: "c1" });
  app.mount(host);
  await flush();
  await expect.poll(() => backend.natsListStreams.mock.calls.length).toBeGreaterThan(0);
  await flush();
  return host;
}

beforeEach(() => {
  backend.natsJetstreamInfo.mockReset().mockResolvedValue({
    enabled: true,
    memoryBytes: 0,
    storageBytes: 1000,
    streams: 1,
    consumers: 1,
  });
  backend.natsListStreams.mockReset().mockResolvedValue({ streams: [STREAM], truncated: false });
  backend.natsGetStream.mockReset().mockResolvedValue(STREAM);
  backend.natsFetchHistory.mockReset().mockResolvedValue({ messages: [], nextSequence: "11", truncated: false, ackMode: "none" });
  backend.natsListConsumers.mockReset().mockResolvedValue({
    consumers: [{ name: "c1", ackPolicy: "explicit", pending: 0 }],
    truncated: false,
  });
  backend.natsGetConsumer.mockReset().mockResolvedValue({
    stream: "ORDERS",
    name: "c1",
    filterSubject: "orders.>",
    ackPolicy: "explicit",
    deliveredConsumerSequence: "0",
    deliveredStreamSequence: "0",
    ackFloorConsumerSequence: "0",
    ackFloorStreamSequence: "0",
    pending: 0,
    ackPending: 0,
    redelivered: 0,
  });
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

describe("NatsJetStreamPanel", () => {
  it("lists streams then drills into messages/consumers without top-level tab hops", async () => {
    const root = await mount();
    expect(root.querySelector('[data-testid="nats-stream-row"]')?.textContent).toContain("ORDERS");

    root.querySelector<HTMLElement>('[data-testid="nats-stream-row"]')!.click();
    await flush();
    await expect.poll(() => backend.natsGetStream.mock.calls.length).toBeGreaterThan(0);
    await flush();

    expect(root.querySelector('[data-testid="nats-js-back"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="nats-history-toolbar"]')).not.toBeNull();
    expect(backend.natsFetchHistory).toHaveBeenCalled();

    root.querySelector<HTMLButtonElement>('[data-testid="nats-js-tab-consumers"]')!.click();
    await flush();
    await expect.poll(() => backend.natsListConsumers.mock.calls.length).toBeGreaterThan(0);
    await flush();
    expect(root.querySelector('[data-testid="nats-consumers-panel"]')).not.toBeNull();

    root.querySelector<HTMLButtonElement>('[data-testid="nats-js-tab-overview"]')!.click();
    await flush();
    expect(root.querySelector('[data-testid="nats-js-overview"]')?.textContent).toContain("10");

    root.querySelector<HTMLButtonElement>('[data-testid="nats-js-back"]')!.click();
    await flush();
    expect(root.querySelector('[data-testid="nats-stream-row"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="nats-js-back"]')).toBeNull();
  });

  it("keeps the requested start sequence when history has no next page", async () => {
    const root = await mount();
    root.querySelector<HTMLElement>('[data-testid="nats-stream-row"]')!.click();
    await flush();
    await expect.poll(() => backend.natsFetchHistory.mock.calls.length).toBeGreaterThan(0);

    backend.natsFetchHistory.mockResolvedValueOnce({ messages: [], truncated: false, ackMode: "none" });
    const startInput = root.querySelector<HTMLInputElement>('.nats-history-filters input[type="text"]')!;
    startInput.value = "2";
    startInput.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>('button[data-testid="nats-history-fetch"]')!.click();
    await flush();

    expect(startInput.value).toBe("2");
  });

  it("preserves large JetStream start sequences as decimal strings", async () => {
    const root = await mount();
    root.querySelector<HTMLElement>('[data-testid="nats-stream-row"]')!.click();
    await flush();
    await expect.poll(() => backend.natsFetchHistory.mock.calls.length).toBeGreaterThan(0);

    const input = root.querySelector<HTMLInputElement>('.nats-history-filters input[type="text"]')!;
    input.value = "9007199254740993";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    root.querySelector<HTMLButtonElement>('[data-testid="nats-history-fetch"]')!.click();
    await flush();

    expect(backend.natsFetchHistory).toHaveBeenLastCalledWith("c1", {
      stream: "ORDERS",
      startSequence: "9007199254740993",
      maxMessages: 50,
    });
  });

  it("does not display history from a stream that was left while the request was pending", async () => {
    backend.natsListStreams.mockResolvedValueOnce({ streams: [STREAM, STREAM_TWO], truncated: false });
    backend.natsGetStream.mockImplementation((name: string) => Promise.resolve(name === STREAM_TWO.name ? STREAM_TWO : STREAM));
    let resolveOldHistory!: (result: unknown) => void;
    backend.natsFetchHistory.mockReset().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldHistory = resolve;
        }),
    );
    backend.natsFetchHistory.mockResolvedValue({
      messages: [{ subject: "payments.created", headers: [], payloadBase64: "cGF5", payloadText: "pay", receivedAtMs: 0, sizeBytes: 3 }],
      truncated: false,
      ackMode: "none",
    });

    const root = await mount();
    root.querySelector<HTMLElement>('[data-testid="nats-stream-row"]')!.click();
    await flush();
    await expect.poll(() => backend.natsFetchHistory.mock.calls.length).toBe(1);

    root.querySelector<HTMLButtonElement>('[data-testid="nats-js-back"]')!.click();
    await flush();
    const rows = root.querySelectorAll<HTMLElement>('[data-testid="nats-stream-row"]');
    rows[1].click();
    await flush();
    await expect.poll(() => backend.natsFetchHistory.mock.calls.length).toBe(2);

    resolveOldHistory({
      messages: [{ subject: "orders.created", headers: [], payloadBase64: "b2xk", payloadText: "old", receivedAtMs: 0, sizeBytes: 3 }],
      truncated: false,
      ackMode: "none",
    });
    await flush();

    expect(root.querySelector(".nats-msg-list")?.textContent).toContain("payments.created");
    expect(root.querySelector(".nats-msg-list")?.textContent).not.toContain("orders.created");
  });

  it("does not leave refresh disabled after returning while refresh is pending", async () => {
    const root = await mount();
    root.querySelector<HTMLElement>('[data-testid="nats-stream-row"]')!.click();
    await flush();

    let resolveRefresh!: (result: unknown) => void;
    backend.natsJetstreamInfo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const refresh = [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("nats.refresh"));
    refresh!.click();
    await flush();

    root.querySelector<HTMLButtonElement>('[data-testid="nats-js-back"]')!.click();
    await flush();

    const listRefresh = [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("nats.refresh"));
    expect(listRefresh?.disabled).toBe(false);

    resolveRefresh({ enabled: true, memoryBytes: 0, storageBytes: 1000, streams: 1, consumers: 1 });
    await flush();
  });
});
