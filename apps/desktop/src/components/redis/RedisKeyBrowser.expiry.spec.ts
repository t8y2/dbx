// @vitest-environment happy-dom

import { CalendarDateTime, resetLocalTimeZone, setLocalTimeZone } from "@internationalized/date";
import { createApp, nextTick, type ComponentPublicInstance } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarDateTimeToUnixSeconds } from "@/components/ui/date-time-picker/dateTimePicker";

const mocks = vi.hoisted(() => ({
  redisScanKeysBatch: vi.fn(),
  redisGetValue: vi.fn(),
  redisSetString: vi.fn(),
  redisJsonSet: vi.fn(),
  redisHashSet: vi.fn(),
  redisListPush: vi.fn(),
  redisSetAdd: vi.fn(),
  redisZadd: vi.fn(),
  redisStreamAdd: vi.fn(),
  redisSetTtl: vi.fn(),
  redisSetExpireAt: vi.fn(),
  redisCheckJsonModule: vi.fn(),
  redisDeleteKey: vi.fn(),
  redisDeleteKeys: vi.fn(),
  toast: vi.fn(),
  updateRedisDbKeyStats: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  redisScanKeysBatch: mocks.redisScanKeysBatch,
  redisGetValue: mocks.redisGetValue,
  redisSetString: mocks.redisSetString,
  redisJsonSet: mocks.redisJsonSet,
  redisHashSet: mocks.redisHashSet,
  redisListPush: mocks.redisListPush,
  redisSetAdd: mocks.redisSetAdd,
  redisZadd: mocks.redisZadd,
  redisStreamAdd: mocks.redisStreamAdd,
  redisSetTtl: mocks.redisSetTtl,
  redisSetExpireAt: mocks.redisSetExpireAt,
  redisCheckJsonModule: mocks.redisCheckJsonModule,
  redisDeleteKey: mocks.redisDeleteKey,
  redisDeleteKeys: mocks.redisDeleteKeys,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: () => ({ name: "Redis", redis_key_separator: ":", redis_scan_page_size: 100 }),
    updateRedisDbKeyStats: mocks.updateRedisDbKeyStats,
    invalidateCompletionCache: vi.fn(),
    refreshRedisDbKeyCounts: vi.fn(),
  }),
}));

vi.mock("@/composables/useEditorFontFamilyStyle", () => ({
  useEditorFontFamilyStyle: () => ({}),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      inheritAttrs: false,
      props: { disabled: Boolean },
      setup(props, { attrs, slots }) {
        return () => h("button", { ...attrs, disabled: props.disabled }, slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Input: defineComponent({
      inheritAttrs: false,
      props: { modelValue: String, disabled: Boolean },
      emits: ["update:modelValue"],
      setup(props, { attrs, emit }) {
        return () =>
          h("input", {
            ...attrs,
            value: props.modelValue ?? "",
            disabled: props.disabled,
            onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
          });
      },
    }),
  };
});

vi.mock("@/components/ui/badge", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Badge: defineComponent({
      setup:
        (_, { attrs, slots }) =>
        () =>
          h("span", attrs, slots.default?.()),
    }),
  };
});

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const slotContainer = defineComponent({
    setup:
      (_, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  return {
    Dialog: defineComponent({
      props: { open: Boolean },
      setup(props, { slots }) {
        return () => (props.open ? h("div", { "data-test-dialog": "" }, slots.default?.()) : null);
      },
    }),
    DialogContent: slotContainer,
    DialogFooter: slotContainer,
    DialogHeader: slotContainer,
    DialogTitle: slotContainer,
  };
});

vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");
  type SelectRoot = HTMLElement & { selectTestValue?: (value: string) => void };
  const slotContainer = defineComponent({
    setup:
      (_, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  return {
    Select: defineComponent({
      inheritAttrs: false,
      props: { modelValue: String, disabled: Boolean },
      emits: ["update:modelValue", "update:open"],
      setup(props, { emit, slots }) {
        const selectValue = (value: string) => {
          if (!props.disabled) emit("update:modelValue", value);
        };
        return () =>
          h(
            "div",
            {
              "data-test-select-root": "",
              ref: (element: Element | ComponentPublicInstance | null) => {
                if (element instanceof HTMLElement) (element as SelectRoot).selectTestValue = selectValue;
              },
            },
            slots.default?.(),
          );
      },
    }),
    SelectContent: slotContainer,
    SelectItem: defineComponent({
      props: { value: String },
      setup(props, { slots }) {
        return () => h("button", { type: "button", "data-test-select-value": props.value }, slots.default?.());
      },
    }),
    SelectTrigger: slotContainer,
    SelectValue: slotContainer,
  };
});

vi.mock("@/components/ui/option-help-panel", async () => {
  const { defineComponent, h } = await import("vue");
  return { OptionHelpPanel: defineComponent({ setup: () => () => h("div") }) };
});

vi.mock("@/components/ui/tabs", async () => {
  const { defineComponent, h } = await import("vue");
  const slotContainer = defineComponent({
    setup:
      (_, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  return { Tabs: slotContainer, TabsContent: slotContainer, TabsList: slotContainer, TabsTrigger: slotContainer };
});

vi.mock("@/components/ui/switch", async () => {
  const { defineComponent, h } = await import("vue");
  return { Switch: defineComponent({ setup: () => () => h("button", { type: "button" }) }) };
});

vi.mock("@/components/ui/date-time-picker/DateTimePicker.vue", async () => {
  const { CalendarDateTime } = await import("@internationalized/date");
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { disabled: Boolean },
      emits: ["update:modelValue"],
      setup(props, { emit }) {
        return () =>
          h(
            "button",
            {
              type: "button",
              disabled: props.disabled,
              "data-test-absolute-date": "",
              onClick: () => emit("update:modelValue", new CalendarDateTime(2030, 1, 2, 3, 4, 5)),
            },
            "Set date",
          );
      },
    }),
  };
});

vi.mock("@/components/ui/CustomContextMenu.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      setup(_, { slots }) {
        return () => h("div", slots.default?.({ onContextMenu: () => undefined }));
      },
    }),
  };
});

vi.mock("@/components/editor/DangerConfirmDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: () => () => h("div") }) };
});

vi.mock("./RedisValueViewer.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: () => () => h("div") }) };
});

vi.mock("./RedisPubSubPanel.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: () => () => h("div") }) };
});

vi.mock("./RedisSlowlogPanel.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: () => () => h("div") }) };
});

vi.mock("vue-virtual-scroller", async () => {
  const { defineComponent, h } = await import("vue");
  return { RecycleScroller: defineComponent({ setup: () => () => h("div") }) };
});

vi.mock("splitpanes", async () => {
  const { defineComponent, h } = await import("vue");
  const slotContainer = defineComponent({
    setup:
      (_, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  return { Splitpanes: slotContainer, Pane: slotContainer };
});

import RedisKeyBrowser from "./RedisKeyBrowser.vue";

const KEY_NAME = "new-key";
const KEY_RAW = "bmV3LWtleQ==";
const mountedApps: Array<{ unmount: () => void; host: HTMLElement }> = [];

type CreateType = "string" | "hash" | "list" | "set" | "zset" | "stream" | "json";
type TestSelectRoot = HTMLElement & { selectTestValue?: (value: string) => void };
function redisValue(keyRaw = KEY_RAW) {
  return {
    key_display: KEY_NAME,
    key_raw: keyRaw,
    ttl: 90,
    redis_type: "string" as const,
    data: { kind: "string" as const, content: { raw_base64: "dmFsdWU=", encoding: "utf8" as const } },
  };
}

function redisKeyInfo(keyType = "json") {
  return { key_display: KEY_NAME, key_raw: KEY_RAW, key_type: keyType, ttl: 90, size: 7, value_preview: "{}" };
}

function resetApiMocks() {
  vi.clearAllMocks();
  mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [], total_keys: 0 });
  mocks.redisGetValue.mockImplementation((_connectionId: string, _db: number, keyRaw: string) => Promise.resolve(redisValue(keyRaw)));
  mocks.redisSetString.mockResolvedValue(undefined);
  mocks.redisJsonSet.mockResolvedValue(undefined);
  mocks.redisHashSet.mockResolvedValue(undefined);
  mocks.redisListPush.mockResolvedValue(undefined);
  mocks.redisSetAdd.mockResolvedValue(undefined);
  mocks.redisZadd.mockResolvedValue(undefined);
  mocks.redisStreamAdd.mockResolvedValue(undefined);
  mocks.redisSetTtl.mockResolvedValue(undefined);
  mocks.redisSetExpireAt.mockResolvedValue(undefined);
  mocks.redisCheckJsonModule.mockResolvedValue(true);
  mocks.redisDeleteKey.mockResolvedValue(undefined);
  mocks.redisDeleteKeys.mockResolvedValue(0);
}

function mountBrowser() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(RedisKeyBrowser, { connectionId: "connection", db: 0, blockDangerousRedisCommands: false });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mountedApps.push({ unmount: () => app.unmount(), host });
}

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
}

function clickButtonWithText(text: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((candidate) => candidate.textContent?.includes(text));
  expect(button, text).toBeDefined();
  button!.click();
}

async function setInput(selector: string, value: string) {
  const input = requiredElement<HTMLInputElement>(selector);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

async function select(value: string) {
  const item = requiredElement<HTMLButtonElement>(`[data-test-select-value="${value}"]`);
  const root = item.closest<TestSelectRoot>("[data-test-select-root]");
  expect(root).not.toBeNull();
  expect(root?.selectTestValue).toEqual(expect.any(Function));
  root!.selectTestValue!(value);
  await settle();
}

async function openCreateDialog() {
  requiredElement<HTMLButtonElement>('button[title="redis.createKey"]').click();
  await settle();
  await setInput('input[placeholder="redis.createKeyNamePlaceholder"]', KEY_NAME);
}

async function fillCreateValue(type: CreateType) {
  if (type === "string") {
    const textarea = requiredElement<HTMLTextAreaElement>("textarea");
    textarea.value = "value";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    return;
  }

  await select(type);
  if (type === "json") {
    const textarea = requiredElement<HTMLTextAreaElement>("textarea");
    textarea.value = '{"value":true}';
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    return;
  }

  if (type === "hash" || type === "stream") {
    await setInput('input[placeholder="redis.createFieldPlaceholder"]', "field");
    await setInput('input[placeholder="redis.createValuePlaceholder"]', "value");
    return;
  }

  if (type === "zset") {
    await setInput('input[placeholder="0"]', "1");
    await setInput('input[placeholder="redis.createMember"]', "member");
    return;
  }

  await setInput('input[placeholder="redis.createValuePlaceholder"]', "value");
}

async function submitCreate() {
  clickButtonWithText("redis.createKeySubmit");
  await settle();
}

function expectWriterBefore(mock: { mock: { invocationCallOrder: number[] } }, after: { mock: { invocationCallOrder: number[] } }) {
  expect(mock.mock.invocationCallOrder).toHaveLength(1);
  expect(after.mock.invocationCallOrder).toHaveLength(1);
  expect(mock.mock.invocationCallOrder[0]).toBeLessThan(after.mock.invocationCallOrder[0]!);
}

const writerForType = {
  string: mocks.redisSetString,
  hash: mocks.redisHashSet,
  list: mocks.redisListPush,
  set: mocks.redisSetAdd,
  zset: mocks.redisZadd,
  stream: mocks.redisStreamAdd,
  json: mocks.redisJsonSet,
} as const;

beforeEach(() => {
  resetApiMocks();
  setLocalTimeZone("UTC");
});

afterEach(() => {
  for (const { unmount, host } of mountedApps.splice(0)) {
    unmount();
    host.remove();
  }
  resetLocalTimeZone();
});

describe("RedisKeyBrowser expiry creation", () => {
  it.each(["string", "hash", "list", "set", "zset", "stream", "json"] as const)("writes %s before applying one relative TTL", async (type) => {
    mountBrowser();
    await settle();
    await openCreateDialog();
    await fillCreateValue(type);
    await select("ttl");
    await setInput('input[placeholder="redis.createKeyTtlPlaceholder"]', "90");

    await submitCreate();

    const writer = writerForType[type];
    expect(mocks.redisSetTtl).toHaveBeenCalledWith("connection", 0, KEY_RAW, 90);
    expect(mocks.redisSetExpireAt).not.toHaveBeenCalled();
    expectWriterBefore(writer, mocks.redisSetTtl);
  });

  it("uses PERSIST after a String write when no expiry is selected", async () => {
    mountBrowser();
    await settle();
    await openCreateDialog();
    await fillCreateValue("string");

    await submitCreate();

    expect(mocks.redisSetTtl).toHaveBeenCalledWith("connection", 0, KEY_RAW, -1);
    expect(mocks.redisSetExpireAt).not.toHaveBeenCalled();
    expectWriterBefore(mocks.redisSetString, mocks.redisSetTtl);
  });

  it("uses EXPIREAT after a String write when an absolute time is selected", async () => {
    mountBrowser();
    await settle();
    await openCreateDialog();
    await fillCreateValue("string");
    await select("at");
    requiredElement<HTMLButtonElement>("[data-test-absolute-date]").click();
    await settle();

    await submitCreate();

    const expected = calendarDateTimeToUnixSeconds(new CalendarDateTime(2030, 1, 2, 3, 4, 5));
    expect(mocks.redisSetExpireAt).toHaveBeenCalledWith("connection", 0, KEY_RAW, expected);
    expect(mocks.redisSetTtl).not.toHaveBeenCalled();
    expectWriterBefore(mocks.redisSetString, mocks.redisSetExpireAt);
  });

  it("does not roll back a written key when its expiry command fails and refreshes it", async () => {
    mocks.redisSetTtl.mockRejectedValueOnce(new Error("TTL command failed"));
    mountBrowser();
    await settle();
    await openCreateDialog();
    await fillCreateValue("string");
    await select("ttl");
    await setInput('input[placeholder="redis.createKeyTtlPlaceholder"]', "90");

    await submitCreate();

    expectWriterBefore(mocks.redisSetString, mocks.redisSetTtl);
    expect(mocks.redisGetValue).toHaveBeenCalledWith("connection", 0, KEY_RAW);
    expect(mocks.redisDeleteKey).not.toHaveBeenCalled();
    expect(mocks.redisDeleteKeys).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("TTL command failed", 5000);
  });

  it("removes an existing RedisJSON key only after recovery confirms its deletion", async () => {
    mocks.redisScanKeysBatch.mockResolvedValueOnce({ cursor: 0, keys: [redisKeyInfo()], total_keys: 1 });
    mocks.redisSetTtl.mockRejectedValueOnce(new Error("TTL command failed"));
    mocks.redisGetValue.mockRejectedValueOnce(new Error("RedisJSON key no longer exists")).mockRejectedValueOnce(new Error("RedisJSON key no longer exists"));
    mountBrowser();
    await settle();
    await openCreateDialog();
    await fillCreateValue("json");
    await select("ttl");
    await setInput('input[placeholder="redis.createKeyTtlPlaceholder"]', "90");

    await submitCreate();
    await settle();

    expect(mocks.redisGetValue).toHaveBeenCalledTimes(2);
    expect(mocks.updateRedisDbKeyStats).toHaveBeenCalledWith("connection", 0, { loaded: 0, totalDelta: -1 });
    expect(mocks.toast).toHaveBeenCalledWith("TTL command failed", 5000);
  });

  it("keeps an existing RedisJSON key when retry cannot confirm its deletion", async () => {
    mocks.redisScanKeysBatch.mockResolvedValueOnce({ cursor: 0, keys: [redisKeyInfo()], total_keys: 1 });
    mocks.redisSetTtl.mockRejectedValueOnce(new Error("TTL command failed"));
    mocks.redisGetValue.mockRejectedValueOnce(new Error("RedisJSON key no longer exists")).mockRejectedValueOnce(new Error("network unavailable"));
    mountBrowser();
    await settle();
    await openCreateDialog();
    await fillCreateValue("json");
    await select("ttl");
    await setInput('input[placeholder="redis.createKeyTtlPlaceholder"]', "90");

    await submitCreate();
    await settle();

    expect(mocks.updateRedisDbKeyStats).not.toHaveBeenCalledWith("connection", 0, { loaded: 0, totalDelta: -1 });
    expect(mocks.toast).toHaveBeenCalledWith("TTL command failed", 5000);
  });
});
