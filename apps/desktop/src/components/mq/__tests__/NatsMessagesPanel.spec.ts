// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const backend = vi.hoisted(() => {
  const handlers: Record<string, { onMessage: (e: unknown) => void; onState: (e: unknown) => void; onError: (e: unknown) => void }> = {};
  const stopFns: Record<string, ReturnType<typeof vi.fn>> = {};
  return {
    handlers,
    stopFns,
    startReqs: [] as Array<{ subscriptionId: string; subject: string }>,
    stopSubscription: vi.fn().mockResolvedValue(true),
    startSubscription: vi.fn(async (_conn: string, req: { subscriptionId: string; subject: string }) => {
      backend.startReqs.push(req);
      return { subscriptionId: req.subscriptionId, subject: req.subject, state: "active", receivedCount: 0, droppedCount: 0 };
    }),
    listen: vi.fn(async (_conn: string, subId: string, h: (typeof handlers)[string]) => {
      handlers[subId] = h;
      const stop = vi.fn();
      stopFns[subId] = stop;
      return stop;
    }),
  };
});

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useMqMutationGuard", () => ({ useMqMutationGuard: () => ({ confirmMqWrite: vi.fn().mockResolvedValue(true) }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/backend/errorUtils", () => ({ formatError: (cause: unknown) => String(cause) }));
vi.mock("@/lib/backend/api", () => ({
  natsStartSubscription: backend.startSubscription,
  natsStopSubscription: backend.stopSubscription,
  natsListenSubscription: backend.listen,
  natsCapture: vi.fn(),
  natsPublish: vi.fn(),
}));
vi.mock("@/components/ui/select", async () => (await import("./selectStub")).createSelectStub());
vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const pass = (name: string) =>
    defineComponent({
      name,
      setup:
        (_p, { slots }) =>
        () =>
          h("div", slots.default?.()),
    });
  return { Dialog: pass("Dialog"), DialogScrollContent: pass("DialogScrollContent"), DialogHeader: pass("DialogHeader"), DialogTitle: pass("DialogTitle") };
});
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

import NatsMessagesPanel from "@/components/mq/nats/NatsMessagesPanel.vue";

let app: App | undefined;

function mount(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  app = createApp(NatsMessagesPanel, { connectionId: "conn-1" });
  app.mount(host);
  return host;
}

async function flush() {
  await nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
}

async function subscribeTo(host: HTMLElement, subject: string) {
  const input = host.querySelector<HTMLInputElement>(".sub-subject");
  if (!input) throw new Error("Subject filter input not found");
  input.value = subject;
  input.dispatchEvent(new Event("input"));
  await nextTick();
  const subscribeBtn = host.querySelector<HTMLButtonElement>('[data-testid="nats-receive-action"]');
  if (!subscribeBtn) throw new Error("Subscribe/capture action button not found");
  subscribeBtn.click();
  await flush();
}

function feedChips(host: HTMLElement) {
  return host.querySelectorAll<HTMLElement>('[data-testid="nats-feed-chip"]');
}

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  backend.startReqs.length = 0;
  Object.keys(backend.handlers).forEach((k) => delete backend.handlers[k]);
  Object.keys(backend.stopFns).forEach((k) => delete backend.stopFns[k]);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("NatsMessagesPanel — multi-subscription explorer", () => {
  it("runs concurrent subscriptions, routes messages per feed, and unsubscribes on remove", async () => {
    const host = mount();

    await subscribeTo(host, "orders.>");
    await subscribeTo(host, "events.*");

    // Two feed chips, two live subscriptions started; subject input cleared for the next add.
    expect(feedChips(host).length).toBe(2);
    expect(backend.startReqs.length).toBe(2);
    expect(host.querySelector<HTMLInputElement>(".sub-subject")?.value).toBe("");
    const [first, second] = backend.startReqs;

    // Deliver a message to the FIRST feed; select it and verify it appears there.
    backend.handlers[first.subscriptionId].onMessage({
      connectionId: "conn-1",
      subscriptionId: first.subscriptionId,
      sequence: 1,
      message: { subject: "orders.created", headers: [], payloadBase64: "aGk=", payloadText: "hi", receivedAtMs: 0, sizeBytes: 2 },
    });
    await flush();

    feedChips(host)[0].querySelector<HTMLButtonElement>(".feed-chip-main")!.click();
    await flush();
    expect(host.querySelectorAll(".nats-msg-card").length).toBe(1);

    // The second feed has no messages → its list is empty.
    feedChips(host)[1].querySelector<HTMLButtonElement>(".feed-chip-main")!.click();
    await flush();
    expect(host.querySelectorAll(".nats-msg-card").length).toBe(0);

    // Removing the second feed unsubscribes it and stops its listener.
    feedChips(host)[1].querySelector<HTMLButtonElement>('[data-testid="nats-feed-remove"]')!.click();
    await flush();
    expect(backend.stopSubscription).toHaveBeenCalledWith("conn-1", second.subscriptionId);
    expect(backend.stopFns[second.subscriptionId]).toHaveBeenCalled();
    expect(feedChips(host).length).toBe(1);
  });

  it("focuses an existing live feed instead of duplicating on repeat subscribe", async () => {
    const host = mount();
    await subscribeTo(host, "orders.>");
    // Subject was cleared; re-enter the same subject and subscribe again.
    await subscribeTo(host, "orders.>");
    expect(feedChips(host).length).toBe(1);
    expect(backend.startReqs.length).toBe(1);
  });

  it("batches a busy subscription into one frame before updating its message list", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const host = mount();

    await subscribeTo(host, "orders.>");
    const subscriptionId = backend.startReqs[0].subscriptionId;
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      backend.handlers[subscriptionId].onMessage({
        connectionId: "conn-1",
        subscriptionId,
        sequence,
        message: { subject: "orders.created", headers: [], payloadBase64: "aGk=", payloadText: "hi", receivedAtMs: sequence, sizeBytes: 2 },
      });
    }

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll(".nats-msg-card")).toHaveLength(0);
    frames[0](0);
    await nextTick();

    expect(host.querySelectorAll(".nats-msg-card")).toHaveLength(3);
    expect(host.querySelector(".feed-chip-count")?.textContent).toBe("3");
  });

  it("keeps the newest messages within the per-feed byte budget", async () => {
    const host = mount();
    await subscribeTo(host, "orders.>");
    const subscriptionId = backend.startReqs[0].subscriptionId;
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      backend.handlers[subscriptionId].onMessage({
        connectionId: "conn-1",
        subscriptionId,
        sequence,
        message: { subject: "orders.created", headers: [], payloadBase64: "aGk=", payloadText: "hi", receivedAtMs: sequence, sizeBytes: 8 * 1024 * 1024 },
      });
    }
    await flush();

    expect(host.querySelectorAll(".nats-msg-card")).toHaveLength(2);
    expect(host.querySelector(".feed-chip-count")?.textContent).toBe("3");
  });

  it("ignores stale subscription events after a newer state transition", async () => {
    const host = mount();
    await subscribeTo(host, "orders.>");
    const subscriptionId = backend.startReqs[0].subscriptionId;
    const handlers = backend.handlers[subscriptionId];

    handlers.onState({ connectionId: "conn-1", subscriptionId, sequence: 3, state: "stopped" });
    handlers.onMessage({
      connectionId: "conn-1",
      subscriptionId,
      sequence: 2,
      message: { subject: "orders.created", headers: [], payloadBase64: "aGk=", payloadText: "hi", receivedAtMs: 0, sizeBytes: 2 },
    });
    handlers.onError({ connectionId: "conn-1", subscriptionId, sequence: 1, message: "old failure" });
    await flush();

    expect(host.querySelectorAll(".nats-msg-card")).toHaveLength(0);
    expect(host.querySelector(".feed-chip")?.classList.contains("is-error")).toBe(false);
    host.querySelector<HTMLButtonElement>('[data-testid="nats-feed-remove"]')!.click();
    await flush();
    expect(backend.stopSubscription).not.toHaveBeenCalled();
  });

  it("stops a subscription that finishes creating after the panel is gone", async () => {
    let resolveStart: ((value: { subscriptionId: string; subject: string; state: string; receivedCount: number; droppedCount: number }) => void) | undefined;
    backend.startSubscription.mockImplementationOnce((_conn: string, req: { subscriptionId: string; subject: string }) => {
      backend.startReqs.push(req);
      return new Promise((resolve) => {
        resolveStart = resolve;
      });
    });
    const host = mount();

    await subscribeTo(host, "orders.>");
    const subscriptionId = backend.startReqs[0].subscriptionId;
    app?.unmount();
    expect(backend.stopSubscription).toHaveBeenCalledWith("conn-1", subscriptionId);

    resolveStart?.({ subscriptionId, subject: "orders.>", state: "active", receivedCount: 0, droppedCount: 0 });
    await flush();

    expect(backend.stopSubscription).toHaveBeenCalledTimes(2);
    expect(backend.stopSubscription).toHaveBeenLastCalledWith("conn-1", subscriptionId);
  });
});
