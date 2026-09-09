// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redisGetValue: vi.fn(),
  redisGetTtl: vi.fn(),
  redisSetTtl: vi.fn(),
  redisSetExpireAt: vi.fn(),
  redisLoadMore: vi.fn(),
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  redisGetValue: mocks.redisGetValue,
  redisGetTtl: mocks.redisGetTtl,
  redisSetTtl: mocks.redisSetTtl,
  redisSetExpireAt: mocks.redisSetExpireAt,
  redisLoadMore: mocks.redisLoadMore,
}));

vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: mocks.copyToClipboard }));

vi.mock("@/composables/useEditorFontFamilyStyle", () => ({
  useEditorFontFamilyStyle: () => ({}),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/lib/common/shikiJsonHighlighter", () => ({
  createShikiJsonHighlighter: vi.fn().mockResolvedValue(() => ""),
}));

// The row menu only needs a trigger that forwards attrs and an item that emits
// `select`; real reka-ui behaviour is out of scope for this test.
vi.mock("@/components/ui/dropdown-menu", async () => {
  const { defineComponent, h } = await import("vue");
  const slotHost = defineComponent({
    setup:
      (_props, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  return {
    DropdownMenu: slotHost,
    DropdownMenuContent: slotHost,
    DropdownMenuLabel: slotHost,
    DropdownMenuSeparator: slotHost,
    DropdownMenuTrigger: defineComponent({
      inheritAttrs: false,
      setup:
        (_props, { attrs, slots }) =>
        () =>
          h("div", attrs, slots.default?.()),
    }),
    DropdownMenuItem: defineComponent({
      inheritAttrs: false,
      emits: ["select"],
      setup(_props, { attrs, slots, emit }) {
        return () => h("button", { ...attrs, onClick: () => emit("select") }, slots.default?.());
      },
    }),
  };
});

import RedisValueViewer from "./RedisValueViewer.vue";

const mountedApps: Array<{ unmount: () => void; host: HTMLElement }> = [];

function createLocalStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key) {
      return entries.get(key) ?? null;
    },
    key(index) {
      return [...entries.keys()][index] ?? null;
    },
    removeItem(key) {
      entries.delete(key);
    },
    setItem(key, value) {
      entries.set(key, String(value));
    },
  };
}

afterEach(() => {
  for (const { unmount, host } of mountedApps.splice(0)) {
    unmount();
    host.remove();
  }
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", createLocalStorage());
});

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function blob(text: string) {
  return { raw_base64: btoa(text), encoding: "utf8" as const };
}

function hashValue() {
  return {
    key_display: "log:processed:2026-09-08:24",
    key_raw: "log:processed:2026-09-08:24",
    ttl: 200000,
    redis_type: "hash",
    data: {
      kind: "hash" as const,
      items: [{ field: blob("1653624095260016668"), value: blob("S") }],
      total: 1,
      scan_cursor: undefined,
    },
  };
}

const testI18nMessages = {
  en: {
    grid: { copyValue: "Copy value" },
    redis: {
      copyField: "Copy field",
      copyFieldValue: "Copy field + value",
      copyOptions: "Copy options",
      copied: "Copied",
    },
  },
};

function mountViewer() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(RedisValueViewer, { connectionId: "connection", db: 0, keyDisplay: "key", keyRaw: "key" });
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: "en", messages: testI18nMessages, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mountedApps.push({ unmount: () => app.unmount(), host });
}

function clickCopy(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  button!.click();
}

describe("Redis hash row copy menu", () => {
  it("copies the value from the main button without opening the member detail", async () => {
    mocks.redisGetValue.mockResolvedValue(hashValue());
    mountViewer();
    await settle();

    clickCopy("[data-redis-copy-value]");
    await settle();

    expect(mocks.copyToClipboard).toHaveBeenCalledWith("S");
    expect(document.querySelector("[data-redis-member-utf8-viewer]")).toBeNull();
  });

  it("offers field, value and field + value targets in the dropdown", async () => {
    mocks.redisGetValue.mockResolvedValue(hashValue());
    mountViewer();
    await settle();

    expect(document.querySelector("[data-redis-copy-menu]")).not.toBeNull();

    clickCopy("[data-redis-copy-item-field]");
    await settle();
    expect(mocks.copyToClipboard).toHaveBeenLastCalledWith("1653624095260016668");

    clickCopy("[data-redis-copy-item-value]");
    await settle();
    expect(mocks.copyToClipboard).toHaveBeenLastCalledWith("S");

    clickCopy("[data-redis-copy-item-field-value]");
    await settle();
    expect(mocks.copyToClipboard).toHaveBeenLastCalledWith("1653624095260016668\tS");
  });
});
