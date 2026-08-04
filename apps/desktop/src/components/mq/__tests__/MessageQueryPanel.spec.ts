// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const backend = vi.hoisted(() => ({
  mqListTopics: vi.fn(),
  mqQueryMessagesByKey: vi.fn(),
  mqQueryMessagesByTopic: vi.fn(),
  mqViewMessage: vi.fn(),
  mqPeekMessages: vi.fn(),
  mqSendMessage: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  mqListTopics: backend.mqListTopics,
  mqQueryMessagesByKey: backend.mqQueryMessagesByKey,
  mqQueryMessagesByTopic: backend.mqQueryMessagesByTopic,
  mqViewMessage: backend.mqViewMessage,
  mqPeekMessages: backend.mqPeekMessages,
  mqSendMessage: backend.mqSendMessage,
}));

import MessageQueryPanel from "@/components/mq/MessageQueryPanel.vue";

const TOPIC = {
  name: "Orders",
  shortName: "Orders",
  partitioned: true,
  persistent: true,
  messageType: "NORMAL",
};

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function buttonByExactText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

async function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}

async function mountPanel() {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(MessageQueryPanel, {
    connectionId: "mq-1",
    tenant: "_rocketmq",
    namespace: "default",
    topic: TOPIC,
    mqSystemKind: "rocketmq",
    embedded: true,
  });
  app.config.globalProperties.$t = (key: string) => key;
  app.mount(root);
  await flushUi();
  return root;
}

beforeEach(() => {
  backend.mqListTopics.mockReset();
  backend.mqQueryMessagesByKey.mockReset();
  backend.mqQueryMessagesByTopic.mockReset();
  backend.mqViewMessage.mockReset();
  backend.mqPeekMessages.mockReset();
  backend.mqSendMessage.mockReset();
  backend.mqListTopics.mockResolvedValue([TOPIC]);
  backend.mqQueryMessagesByKey.mockResolvedValue({ messages: [] });
  backend.mqQueryMessagesByTopic.mockResolvedValue({ messages: [] });
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
});

async function waitForQueryEnabled(panel: HTMLElement) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const queryButton = buttonByExactText(panel, "mqMessages.query");
    if (!queryButton.disabled) return queryButton;
    await flushUi();
  }
  throw new Error("Query button stayed disabled (topic not selected)");
}

describe("MessageQueryPanel Key mode time validation", () => {
  it("does not block Key query with a stale invalid Topic time range", async () => {
    const panel = await mountPanel();
    await expect.poll(() => backend.mqListTopics.mock.calls.length).toBeGreaterThan(0);
    await flushUi();

    const beginInput = panel.querySelector<HTMLInputElement>('input[type="datetime-local"]');
    const endInputs = panel.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]');
    if (!beginInput || endInputs.length < 2) throw new Error("Topic time inputs not found");
    // Invalid range: begin after end (hidden after switching to Key).
    await setInputValue(beginInput, "2026-08-03T18:00");
    await setInputValue(endInputs[1], "2026-08-03T10:00");

    buttonByExactText(panel, "mqMessages.queryTabKey").click();
    await flushUi();

    const keyInput = panel.querySelector<HTMLInputElement>('input[placeholder="mqMessages.queryKeyPlaceholder"]');
    if (!keyInput) throw new Error("Key input not found");
    await setInputValue(keyInput, "order-1");

    const queryButton = await waitForQueryEnabled(panel);
    queryButton.click();
    await flushUi();
    await expect.poll(() => backend.mqQueryMessagesByKey.mock.calls.length).toBe(1);

    expect(panel.textContent).not.toContain("mqMessages.invalidTimeRange");
    expect(panel.textContent).not.toContain("mqMessages.endTimeMustBeAfterBegin");
    expect(backend.mqQueryMessagesByTopic).not.toHaveBeenCalled();
    const [, topicRef, key, begin, end, maxNum] = backend.mqQueryMessagesByKey.mock.calls[0];
    expect(topicRef).toMatchObject({ topic: "Orders" });
    expect(key).toBe("order-1");
    expect(begin).toBe(0);
    expect(typeof end).toBe("number");
    expect(end).toBeGreaterThan(0);
    expect(maxNum).toBe(64);
  });
});
