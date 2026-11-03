// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redisGetValue: vi.fn(),
  redisGetTtl: vi.fn(),
  redisSetTtl: vi.fn(),
  redisSetExpireAt: vi.fn(),
  redisListPush: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  redisGetValue: mocks.redisGetValue,
  redisGetTtl: mocks.redisGetTtl,
  redisSetTtl: mocks.redisSetTtl,
  redisSetExpireAt: mocks.redisSetExpireAt,
  redisListPush: mocks.redisListPush,
}));
vi.mock("@/composables/useEditorFontFamilyStyle", () => ({ useEditorFontFamilyStyle: () => ({}) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/common/shikiJsonHighlighter", () => ({ createShikiJsonHighlighter: vi.fn().mockResolvedValue(() => "") }));

import RedisValueViewer from "./RedisValueViewer.vue";

const mountedApps: Array<{ unmount: () => void; host: HTMLElement }> = [];

async function settleRounds(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

afterEach(() => {
  for (const { unmount, host } of mountedApps.splice(0)) {
    unmount();
    host.remove();
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redisListPush.mockResolvedValue(undefined);
  mocks.redisGetValue.mockResolvedValue({
    key_display: "queue",
    key_raw: "queue",
    ttl: -1,
    redis_type: "list",
    data: {
      kind: "list",
      items: [
        { index: 0, value: { raw_base64: "Zmlyc3Q=", encoding: "utf8" } },
        { index: 1, value: { raw_base64: "c2Vjb25k", encoding: "utf8" } },
      ],
      total: 2,
    },
  });
});

async function mountListViewer() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      setup: () => () => h(RedisValueViewer, { connectionId: "connection", db: 0, keyDisplay: "queue", keyRaw: "queue" }),
    }),
  );
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: { en: { redis: { pushAction: "Push", pushSide: "Push position", pushSideLeft: "Head (LPUSH)", pushSideRight: "Tail (RPUSH)", valuePlaceholder: "New value" } } },
      missingWarn: false,
      fallbackWarn: false,
    }),
  );
  app.mount(host);
  mountedApps.push({ unmount: () => app.unmount(), host });
  await settleRounds();
  return host;
}

function newValueInput(host: HTMLElement): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>("input[placeholder='New value']");
  if (!input) throw new Error("New-value input not found");
  return input;
}

async function typeAndPush(host: HTMLElement, value: string) {
  const input = newValueInput(host);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("Push"));
  if (!button) throw new Error("Push button not found");
  button.click();
  await settleRounds();
}

async function selectSide(host: HTMLElement, side: "left" | "right") {
  const label = side === "left" ? "Head (LPUSH)" : "Tail (RPUSH)";
  const trigger = host.querySelector<HTMLButtonElement>("[role='combobox']");
  if (!trigger) throw new Error("Push-side select trigger not found");
  // reka-ui's Select opens from keyboard events in happy-dom; a plain click is ignored.
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settleRounds(2);
  const option = [...document.querySelectorAll<HTMLElement>("[role='option']")].find((candidate) => candidate.textContent?.includes(label));
  if (!option) throw new Error(`Push-side option not found: ${side}`);
  // reka-ui commits the selection from a keydown on the item, not from click.
  option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settleRounds(2);
}

describe("RedisValueViewer list push side", () => {
  it("pushes to the tail (RPUSH) by default", async () => {
    const host = await mountListViewer();

    await typeAndPush(host, "queued");

    expect(mocks.redisListPush).toHaveBeenCalledWith("connection", 0, "queue", "queued", undefined, "right");
  });

  it("pushes to the head (LPUSH) after switching the side select", async () => {
    const host = await mountListViewer();

    await selectSide(host, "left");
    await typeAndPush(host, "urgent");

    expect(mocks.redisListPush).toHaveBeenCalledWith("connection", 0, "queue", "urgent", undefined, "left");
  });

  it("keeps the selected side for subsequent pushes and clears the input", async () => {
    const host = await mountListViewer();

    await selectSide(host, "left");
    await typeAndPush(host, "first");
    await typeAndPush(host, "second");

    expect(mocks.redisListPush).toHaveBeenCalledTimes(2);
    expect(mocks.redisListPush.mock.calls.every((call) => call[5] === "left")).toBe(true);
    expect(newValueInput(host).value).toBe("");
  });
});
