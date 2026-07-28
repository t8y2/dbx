// @vitest-environment happy-dom

import { CalendarDateTime, resetLocalTimeZone, setLocalTimeZone } from "@internationalized/date";
import { createApp, defineComponent, h, KeepAlive, nextTick, ref, type ComponentPublicInstance } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarDateTimeToUnixSeconds } from "@/components/ui/date-time-picker/dateTimePicker";
import type { RedisKeyInfo } from "@/lib/backend/api";

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
  canBuildRedisFuzzyTree: vi.fn((loadedKeyCount: number) => loadedKeyCount <= 200_000),
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

vi.mock("@/lib/redis/redisKeyTree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis/redisKeyTree")>();
  return { ...actual, canBuildRedisFuzzyTree: mocks.canBuildRedisFuzzyTree };
});

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
  return {
    default: defineComponent({
      props: { open: Boolean, loading: Boolean, details: String },
      emits: ["confirm"],
      setup(props, { emit }) {
        return () =>
          props.open
            ? h("div", { "data-test-danger-dialog": "" }, [
                h("div", { "data-test-danger-details": "" }, props.details),
                h(
                  "button",
                  {
                    type: "button",
                    disabled: props.loading,
                    "data-test-danger-confirm": "",
                    onClick: () => emit("confirm"),
                  },
                  "Confirm",
                ),
              ])
            : null;
      },
    }),
  };
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
  return {
    RecycleScroller: defineComponent({
      inheritAttrs: false,
      props: { items: { type: Array, default: () => [] } },
      setup(props, { attrs, slots }) {
        // Mirror the real scroller: interaction tests should render a viewport,
        // not every row in a deliberately large result set.
        const visibleItemCount = 50;
        return () =>
          h(
            "div",
            attrs,
            props.items.slice(0, visibleItemCount).map((item) => slots.default?.({ item })),
          );
      },
    }),
  };
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
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
  mocks.canBuildRedisFuzzyTree.mockImplementation((loadedKeyCount: number) => loadedKeyCount <= 200_000);
}

function mountBrowser() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(RedisKeyBrowser, { connectionId: "connection", db: 0, blockDangerousRedisCommands: false });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mountedApps.push({ unmount: () => app.unmount(), host });
}

function mountScopedBrowser() {
  const connectionId = ref("connection");
  const db = ref(0);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(RedisKeyBrowser, { connectionId: connectionId.value, db: db.value, blockDangerousRedisCommands: false });
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mountedApps.push({ unmount: () => app.unmount(), host });

  return {
    host,
    async setScope(nextConnectionId: string, nextDb: number) {
      connectionId.value = nextConnectionId;
      db.value = nextDb;
      await settle();
    },
  };
}

function mountKeptAliveBrowser() {
  const active = ref(true);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(KeepAlive, null, {
            default: () => (active.value ? h(RedisKeyBrowser, { connectionId: "connection", db: 0, blockDangerousRedisCommands: false }) : null),
          });
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mountedApps.push({ unmount: () => app.unmount(), host });

  return {
    async deactivate() {
      active.value = false;
      await settle();
    },
    async activate() {
      active.value = true;
      await settle();
    },
  };
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

async function submitKeySearch(value: string) {
  const input = requiredElement<HTMLInputElement>("[data-redis-search-input]");
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
}

function groupCheckbox(label: string): HTMLInputElement {
  const labelElement = Array.from(document.querySelectorAll<HTMLElement>(".dbx-editor-font-family")).find((element) => element.textContent === label);
  expect(labelElement, label).toBeDefined();
  const checkbox = labelElement?.closest(".group")?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(checkbox, label).toBeDefined();
  return checkbox!;
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

describe("RedisKeyBrowser scope changes", () => {
  it("reloads the new database and discards a late scan from the previous one", async () => {
    const previousDatabase = deferred<{ cursor: number; keys: RedisKeyInfo[]; total_keys: number }>();
    const currentKey = { key_display: "db1-key", key_raw: "ZGIxLWtleQ==", key_type: "string", ttl: -1 };
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, db: number) => {
      if (db === 0) return previousDatabase.promise;
      return Promise.resolve({ cursor: 0, keys: [currentKey], total_keys: 1 });
    });
    const browser = mountScopedBrowser();
    await settle();

    expect(mocks.redisScanKeysBatch).toHaveBeenCalledWith("connection", 0, 0, "*", 100, 8, false);

    await browser.setScope("connection", 1);

    expect(mocks.redisScanKeysBatch).toHaveBeenCalledWith("connection", 1, 0, "*", 100, 8, false);
    previousDatabase.resolve({
      cursor: 0,
      keys: [{ key_display: "db0-key", key_raw: "ZGIwLWtleQ==", key_type: "string", ttl: -1 }],
      total_keys: 1,
    });
    await settle();

    expect(browser.host.textContent).toContain("db1-key");
    expect(browser.host.textContent).not.toContain("db0-key");
  });
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

describe("RedisKeyBrowser fuzzy key hierarchy", () => {
  it("keeps NUL-containing fuzzy groups isolated when selecting keys to delete", async () => {
    const firstKeyRaw = "cmF3LWZpcnN0";
    const secondKeyRaw = "cmF3LXNlY29uZA==";
    const keys = [
      { key_display: `a\0b:c:x`, key_raw: firstKeyRaw, key_type: "string", ttl: -1 },
      { key_display: `a:b\0c:y`, key_raw: secondKeyRaw, key_type: "string", ttl: -1 },
    ];
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys, total_keys: keys.length });
    mocks.redisDeleteKeys.mockResolvedValue(1);
    mountBrowser();
    await settle();

    await submitKeySearch("a");
    clickButtonWithText("redis.fuzzyMatch");
    await settle();

    const firstGroupCheckbox = groupCheckbox(`a\0b`);
    firstGroupCheckbox.checked = true;
    firstGroupCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    const deleteButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "1");
    expect(deleteButton).toBeDefined();
    deleteButton!.click();
    await settle();
    requiredElement<HTMLButtonElement>("[data-test-danger-confirm]").click();
    await settle();

    expect(mocks.redisDeleteKeys).toHaveBeenCalledTimes(1);
    expect(mocks.redisDeleteKeys).toHaveBeenCalledWith("connection", 0, [firstKeyRaw]);
    expect(mocks.redisDeleteKeys.mock.calls[0]?.[2]).not.toContain(secondKeyRaw);
  });

  it("keeps regular key searches flat, then selects and deletes a loaded fuzzy branch", async () => {
    const keys = [
      { key_display: "user:profile:email", key_raw: "cmF3LWVtYWls", key_type: "string", ttl: -1 },
      { key_display: "user:profile:name", key_raw: "cmF3LW5hbWU=", key_type: "string", ttl: -1 },
      { key_display: "user:settings", key_raw: "cmF3LXNldHRpbmdz", key_type: "hash", ttl: -1 },
    ];
    // The first page is intentionally incomplete: branch selection must only
    // submit the currently loaded raw keys, never widen into a new SCAN.
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 7, keys, total_keys: 20 });
    mocks.redisDeleteKeys.mockResolvedValue(keys.length);
    mountBrowser();
    await settle();

    await submitKeySearch("user");
    // Regular glob search keeps the pre-existing flat, virtualized result path.
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(keys.length);

    clickButtonWithText("redis.fuzzyMatch");
    await settle();

    // Fuzzy search restores the namespace hierarchy and exposes group selection.
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(keys.length + 2);
    const userCheckbox = groupCheckbox("user");
    userCheckbox.checked = true;
    userCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();

    const deleteButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === String(keys.length));
    expect(deleteButton).toBeDefined();
    deleteButton!.click();
    await settle();
    requiredElement<HTMLButtonElement>("[data-test-danger-confirm]").click();
    await settle();

    expect(mocks.redisDeleteKeys).toHaveBeenCalledTimes(1);
    const [connectionId, db, deletedKeyRaws] = mocks.redisDeleteKeys.mock.calls[0] ?? [];
    expect(connectionId).toBe("connection");
    expect(db).toBe(0);
    expect(new Set(deletedKeyRaws)).toEqual(new Set(keys.map((key) => key.key_raw)));
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it("falls back to flat rows at the fuzzy tree limit while retaining loaded-result delete wording", async () => {
    const keys = [
      { key_display: "user:profile:email", key_raw: "cmF3LWVtYWls", key_type: "string", ttl: -1 },
      { key_display: "user:profile:name", key_raw: "cmF3LW5hbWU=", key_type: "string", ttl: -1 },
    ];
    mocks.canBuildRedisFuzzyTree.mockReturnValue(false);
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys, total_keys: keys.length });
    mocks.redisDeleteKeys.mockResolvedValue(1);
    mountBrowser();
    await settle();

    await submitKeySearch("user");
    clickButtonWithText("redis.fuzzyMatch");
    await settle();

    // The group controls disappear when the view falls back to virtualized rows.
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(keys.length);
    expect(document.body.textContent).toContain("redis.fuzzyTreeLimit");

    requiredElement<HTMLInputElement>('input[type="checkbox"]').click();
    await settle();
    const deleteButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "1");
    expect(deleteButton).toBeDefined();
    deleteButton!.click();
    await settle();
    expect(requiredElement<HTMLElement>("[data-test-danger-details]").textContent).toContain("redis.deleteLoadedSearchKeysDetails");
    requiredElement<HTMLButtonElement>("[data-test-danger-confirm]").click();
    await settle();

    expect(mocks.redisDeleteKeys).toHaveBeenCalledWith("connection", 0, [keys[0]!.key_raw]);
  });

  it("keeps a selected fuzzy group partial when a later SCAN page adds matching keys", async () => {
    const firstPageKeys = [{ key_display: "user:one", key_raw: "dXNlci1vbmU=", key_type: "string", ttl: -1 }];
    const laterPageKeys = [{ key_display: "user:two", key_raw: "dXNlci10d28=", key_type: "string", ttl: -1 }];
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number) => Promise.resolve(cursor === 0 ? { cursor: 7, keys: firstPageKeys, total_keys: 2 } : { cursor: 0, keys: laterPageKeys, total_keys: 0 }));
    mocks.redisDeleteKeys.mockResolvedValue(1);
    mountBrowser();
    await settle();

    await submitKeySearch("user");
    clickButtonWithText("redis.fuzzyMatch");
    await settle();

    const userCheckbox = groupCheckbox("user");
    userCheckbox.checked = true;
    userCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    clickButtonWithText("redis.loadMoreKeys");
    await settle();

    const updatedUserCheckbox = groupCheckbox("user");
    expect(updatedUserCheckbox.checked).toBe(false);
    expect(updatedUserCheckbox.indeterminate).toBe(true);
    const deleteButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "1");
    expect(deleteButton).toBeDefined();
    deleteButton!.click();
    await settle();
    requiredElement<HTMLButtonElement>("[data-test-danger-confirm]").click();
    await settle();

    expect(mocks.redisDeleteKeys).toHaveBeenCalledWith("connection", 0, [firstPageKeys[0]!.key_raw]);
  });

  it("sends a large selected fuzzy group in bounded delete batches", async () => {
    const keys = Array.from({ length: 1_001 }, (_, index) => ({
      key_display: `batch:${String(index).padStart(4, "0")}`,
      key_raw: `cmF3LWJhdGNoLS${index}`,
      key_type: "string",
      ttl: -1,
    }));
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys, total_keys: keys.length });
    mocks.redisDeleteKeys.mockImplementation(async (_connectionId: string, _db: number, keyRaws: string[]) => keyRaws.length);
    mountBrowser();
    await settle();

    await submitKeySearch("batch");
    clickButtonWithText("redis.fuzzyMatch");
    await settle();

    const batchCheckbox = groupCheckbox("batch");
    batchCheckbox.checked = true;
    batchCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    const deleteButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === String(keys.length));
    expect(deleteButton).toBeDefined();
    deleteButton!.click();
    await settle();
    requiredElement<HTMLButtonElement>("[data-test-danger-confirm]").click();
    await settle();
    await settle();

    expect(mocks.redisDeleteKeys.mock.calls.map((call) => call[2]?.length)).toEqual([1_000, 1]);
    expect(new Set(mocks.redisDeleteKeys.mock.calls.flatMap((call) => call[2] ?? []))).toEqual(new Set(keys.map((key) => key.key_raw)));
  });

  it("reloads the result set when a later delete batch fails after an earlier batch succeeds", async () => {
    const keys = Array.from({ length: 1_001 }, (_, index) => ({
      key_display: `batch:${String(index).padStart(4, "0")}`,
      key_raw: `cmF3LWJhdGNoLS${index}`,
      key_type: "string",
      ttl: -1,
    }));
    const freshKeys = [{ key_display: "fresh:remaining", key_raw: "ZnJlc2gtcmVtYWluaW5n", key_type: "string", ttl: -1 }];
    let returnFreshResults = false;
    mocks.redisScanKeysBatch.mockImplementation(() => Promise.resolve(returnFreshResults ? { cursor: 0, keys: freshKeys, total_keys: 1 } : { cursor: 0, keys, total_keys: keys.length }));
    mocks.redisDeleteKeys.mockResolvedValueOnce(1_000).mockImplementationOnce(async () => {
      returnFreshResults = true;
      throw new Error("second batch failed");
    });
    mountBrowser();
    await settle();

    await submitKeySearch("batch");
    clickButtonWithText("redis.fuzzyMatch");
    await settle();

    const batchCheckbox = groupCheckbox("batch");
    batchCheckbox.checked = true;
    batchCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    const deleteButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === String(keys.length));
    expect(deleteButton).toBeDefined();
    deleteButton!.click();
    await settle();
    requiredElement<HTMLButtonElement>("[data-test-danger-confirm]").click();
    await settle();
    await settle();

    expect(mocks.redisDeleteKeys.mock.calls.map((call) => call[2]?.length)).toEqual([1_000, 1]);
    expect(mocks.toast).toHaveBeenCalledWith("second batch failed", 5000);
    expect(document.body.textContent).toContain("fresh");
    expect(document.body.textContent).not.toContain("0000");
  });

  it("reloads after a later delete batch fails while the browser is deactivated", async () => {
    const keys = Array.from({ length: 1_001 }, (_, index) => ({
      key_display: `batch:${String(index).padStart(4, "0")}`,
      key_raw: `cmF3LWJhdGNoLS${index}`,
      key_type: "string",
      ttl: -1,
    }));
    const freshKeys = [{ key_display: "fresh:remaining", key_raw: "ZnJlc2gtcmVtYWluaW5n", key_type: "string", ttl: -1 }];
    const laterDelete = deferred<number>();
    let returnFreshResults = false;
    mocks.redisScanKeysBatch.mockImplementation(() => Promise.resolve(returnFreshResults ? { cursor: 0, keys: freshKeys, total_keys: 1 } : { cursor: 0, keys, total_keys: keys.length }));
    mocks.redisDeleteKeys.mockResolvedValueOnce(1_000).mockImplementationOnce(() => laterDelete.promise);
    const browser = mountKeptAliveBrowser();
    await settle();

    await submitKeySearch("batch");
    clickButtonWithText("redis.fuzzyMatch");
    await settle();

    const batchCheckbox = groupCheckbox("batch");
    batchCheckbox.checked = true;
    batchCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    const deleteButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === String(keys.length));
    expect(deleteButton).toBeDefined();
    deleteButton!.click();
    await settle();
    requiredElement<HTMLButtonElement>("[data-test-danger-confirm]").click();
    await settle();

    expect(mocks.redisDeleteKeys.mock.calls.map((call) => call[2]?.length)).toEqual([1_000, 1]);
    await browser.deactivate();
    returnFreshResults = true;
    laterDelete.reject(new Error("second batch failed while inactive"));
    await settle();
    const scanCountBeforeActivation = mocks.redisScanKeysBatch.mock.calls.length;

    await browser.activate();
    await settle();

    expect(mocks.toast).toHaveBeenCalledWith("second batch failed while inactive", 5000);
    expect(mocks.redisScanKeysBatch.mock.calls.length).toBeGreaterThan(scanCountBeforeActivation);
    expect(document.body.textContent).toContain("fresh");
    expect(document.body.textContent).not.toContain("0000");
  });
});

describe("RedisKeyBrowser interrupted Fetch All", () => {
  it("reloads instead of advancing past an uncommitted buffered page after reactivation", async () => {
    const bufferedPage = deferred<{ cursor: number; keys: Array<{ key_display: string; key_raw: string; key_type: string; ttl: number }>; total_keys: number }>();
    let returnFreshPage = false;
    let freshPageRequests = 0;
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number) => {
      if (cursor === 1) return bufferedPage.promise;
      if (returnFreshPage) freshPageRequests++;
      return Promise.resolve(returnFreshPage ? { cursor: 0, keys: [{ key_display: "fresh:key", key_raw: "ZnJlc2gta2V5", key_type: "string", ttl: -1 }], total_keys: 2 } : { cursor: 1, keys: [{ key_display: "initial:key", key_raw: "aW5pdGlhbC1rZXk=", key_type: "string", ttl: -1 }], total_keys: 2 });
    });
    const browser = mountKeptAliveBrowser();
    await settle();

    clickButtonWithText("redis.fetchAllKeys");
    await settle();

    await browser.deactivate();
    returnFreshPage = true;
    bufferedPage.resolve({ cursor: 0, keys: [{ key_display: "buffered:key", key_raw: "YnVmZmVyZWQta2V5", key_type: "string", ttl: -1 }], total_keys: 0 });
    await settle();
    await browser.activate();
    await settle();

    expect(document.body.textContent).toContain("fresh");
    expect(document.body.textContent).not.toContain("buffered");
    expect(freshPageRequests).toBeGreaterThan(0);
  });
});
