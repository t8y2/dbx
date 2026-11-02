// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";

const backend = vi.hoisted(() => ({
  mqBind: vi.fn(),
  mqCreateExchange: vi.fn(),
  mqDeleteExchange: vi.fn(),
  mqListBindings: vi.fn(),
  mqListExchangesPage: vi.fn(),
  mqListTopicsPage: vi.fn(),
  mqUnbind: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string, params?: { page?: number }) => (params?.page ? `${key}:${params.page}` : key) }),
}));

vi.mock("@/lib/backend/api", () => backend);

vi.mock("@/composables/useMqMutationGuard", () => ({
  useMqMutationGuard: () => ({ confirmMqWrite: vi.fn().mockResolvedValue(true) }),
}));

vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({
  default: defineComponent({ setup: () => () => h("div") }),
}));

import ExchangesPanel from "@/components/mq/ExchangesPanel.vue";

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

async function mountPanel(namespace = "/") {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(ExchangesPanel, {
    connectionId: "rabbit-1",
    tenant: "_rabbitmq",
    namespace,
  });
  app.mount(root);
  await flushUi();
  return root;
}

function exchangeNames(container: ParentNode): string[] {
  return [...container.querySelectorAll<HTMLElement>(".exchange-name-cell > span:first-child")].map((item) => item.textContent ?? "");
}

beforeEach(() => {
  vi.useRealTimers();
  Object.values(backend).forEach((mock) => mock.mockReset());
  backend.mqListBindings.mockResolvedValue([]);
  backend.mqListTopicsPage.mockResolvedValue({ items: [], page: 1, pageSize: 100, totalCount: 0, hasMore: false });
  backend.mqListExchangesPage.mockResolvedValue({
    items: [{ name: "events", type: "topic", durable: true, autoDelete: false, internal: false }],
    page: 1,
    pageSize: 100,
    totalCount: 1,
    hasMore: false,
  });
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
  vi.useRealTimers();
});

describe("ExchangesPanel RabbitMQ pagination", () => {
  it("requests one page at a time and retains all-vhost row identity", async () => {
    backend.mqListExchangesPage
      .mockResolvedValueOnce({
        items: [{ name: "events", namespace: "/", type: "topic", durable: true, autoDelete: false, internal: false }],
        page: 1,
        pageSize: 100,
        totalCount: 101,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [{ name: "events", namespace: "/staging", type: "topic", durable: true, autoDelete: false, internal: false }],
        page: 2,
        pageSize: 100,
        totalCount: 101,
        hasMore: false,
      });
    const panel = await mountPanel("*");

    expect(exchangeNames(panel)).toEqual(["events"]);
    expect(panel.querySelector("tbody td:nth-child(2)")?.textContent?.trim()).toBe("/");
    const next = panel.querySelector<HTMLButtonElement>('[data-testid="mq-list-next"]');
    if (!next) throw new Error("next page button not found");
    next.click();
    await flushUi();

    expect(panel.querySelector("tbody td:nth-child(2)")?.textContent?.trim()).toBe("/staging");
    expect(backend.mqListExchangesPage).toHaveBeenLastCalledWith("rabbit-1", { tenant: "_rabbitmq", namespace: "*" }, expect.objectContaining({ page: 2, pageSize: 100, sort: "name" }));
  });

  it("debounces search into the server-side page request", async () => {
    vi.useFakeTimers();
    const panel = await mountPanel();
    backend.mqListExchangesPage.mockClear();
    backend.mqListExchangesPage.mockResolvedValue({ items: [], page: 1, pageSize: 100, totalCount: 0, hasMore: false });

    const search = panel.querySelector<HTMLInputElement>(".exchange-search");
    if (!search) throw new Error("exchange search not found");
    search.value = "orders";
    search.dispatchEvent(new Event("input"));
    await nextTick();
    expect(backend.mqListExchangesPage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    await flushUi();
    expect(backend.mqListExchangesPage).toHaveBeenCalledWith("rabbit-1", { tenant: "_rabbitmq", namespace: "/" }, expect.objectContaining({ page: 1, search: "orders" }));
  });
});
