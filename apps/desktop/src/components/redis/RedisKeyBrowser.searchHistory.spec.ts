// @vitest-environment happy-dom

import { createApp, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetRedisKeySearchHistory, loadRedisKeySearchHistory, rememberRedisKeySearchHistory } from "@/lib/redis/redisKeySearchHistory";

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
  redisExecuteCommand: vi.fn(),
  saveHistory: vi.fn(),
  toast: vi.fn(),
  updateRedisDbKeyStats: vi.fn(),
  listRedisCompletionCommandDocs: vi.fn(),
  listRedisCompletionKeys: vi.fn(),
  redisScanPageSize: 100,
  infiniteScroll: false,
  queryResultMaxRowsEnabled: true,
  queryResultMaxRows: 5000,
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
  redisExecuteCommand: mocks.redisExecuteCommand,
  saveHistory: mocks.saveHistory,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: () => ({ name: "Redis", redis_key_separator: ":", redis_scan_page_size: mocks.redisScanPageSize, redis_key_templates: ["user:{$id}", "session:{$token}"] }),
    updateRedisDbKeyStats: mocks.updateRedisDbKeyStats,
    listRedisCompletionCommandDocs: mocks.listRedisCompletionCommandDocs,
    listRedisCompletionKeys: mocks.listRedisCompletionKeys,
    invalidateCompletionCache: vi.fn(),
    refreshRedisDbKeyCounts: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      infiniteScroll: mocks.infiniteScroll,
      queryResultMaxRowsEnabled: mocks.queryResultMaxRowsEnabled,
      queryResultMaxRows: mocks.queryResultMaxRows,
    },
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
  const { defineComponent, h, mergeProps } = await import("vue");
  return {
    Input: defineComponent({
      inheritAttrs: false,
      props: { modelValue: String, disabled: Boolean },
      emits: ["update:modelValue"],
      setup(props, { attrs, emit }) {
        return () =>
          h(
            "input",
            mergeProps(attrs, {
              value: props.modelValue ?? "",
              disabled: props.disabled,
              onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
            }),
          );
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
  const slotContainer = defineComponent({
    setup:
      (_, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  return {
    Select: slotContainer,
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
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: () => () => h("div") }) };
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
  return { default: defineComponent({ props: { open: Boolean }, setup: () => () => h("div") }) };
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
        return () =>
          h(
            "div",
            attrs,
            props.items.slice(0, 20).map((item) => slots.default?.({ item })),
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

const mountedApps: Array<{ unmount: () => void; host: HTMLElement }> = [];

async function settle() {
  for (let index = 0; index < 4; index++) {
    await nextTick();
    await Promise.resolve();
  }
}

function mountBrowser(overrides?: { connectionId?: string; db?: number; stateKey?: string }) {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(RedisKeyBrowser, {
    connectionId: overrides?.connectionId ?? "connection",
    db: overrides?.db ?? 0,
    blockDangerousRedisCommands: false,
    stateKey: overrides?.stateKey,
  });
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: {
        en: {
          redis: {
            keySearchHistory: "Search history",
            keySearchHistoryForget: "Remove from history",
            keySearchHistoryEmpty: "No history yet",
            keyTemplateSuggestions: "Key templates",
          },
        },
      },
      missingWarn: false,
      fallbackWarn: false,
    }),
  );
  app.mount(host);
  mountedApps.push({ unmount: () => app.unmount(), host });
  return host;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [], total_keys: 0 });
  localStorage.clear();
});

afterEach(() => {
  while (mountedApps.length > 0) {
    const mounted = mountedApps.pop()!;
    mounted.unmount();
    mounted.host.remove();
  }
});

async function submitSearch(host: HTMLElement, pattern: string) {
  const input = host.querySelector("[data-redis-search-input]") as HTMLInputElement;
  input.value = pattern;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
}

describe("RedisKeyBrowser search history", () => {
  it("remembers a submitted pattern and fills the input when selected from history", async () => {
    const host = mountBrowser();
    await settle();

    await submitSearch(host, "monitor:job:*");
    expect(loadRedisKeySearchHistory({ connectionId: "connection", db: 0 })).toEqual(["monitor:job:*"]);

    const input = host.querySelector("[data-redis-search-input]") as HTMLInputElement;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();

    (host.querySelector("[data-redis-search-history-toggle]") as HTMLButtonElement).click();
    await settle();

    expect(host.querySelector("[data-redis-search-history-list]")).not.toBeNull();
    const item = host.querySelector("[data-redis-search-history-item]") as HTMLElement;
    expect(item.textContent).toContain("monitor:job:*");
    item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await settle();

    expect((host.querySelector("[data-redis-search-input]") as HTMLInputElement).value).toBe("monitor:job:*");
    expect(host.querySelector("[data-redis-search-history-list]")).toBeNull();
  });

  it("keeps earlier patterns after switching to another key search like queue_update then insert", async () => {
    const host = mountBrowser();
    await settle();

    await submitSearch(host, "queue_update");
    await submitSearch(host, "insert");

    expect(loadRedisKeySearchHistory({ connectionId: "connection", db: 0 })).toEqual(["insert", "queue_update"]);

    // Input still holds the latest search; dropdown must still list earlier keys.
    (host.querySelector("[data-redis-search-history-toggle]") as HTMLButtonElement).click();
    await settle();

    const text = host.querySelector("[data-redis-search-history-list]")?.textContent ?? "";
    expect(text).toContain("insert");
    expect(text).toContain("queue_update");
  });

  it("forgets an individual history entry from the dropdown", async () => {
    rememberRedisKeySearchHistory({ connectionId: "connection", db: 0 }, "cache:*");
    rememberRedisKeySearchHistory({ connectionId: "connection", db: 0 }, "user:*");

    const host = mountBrowser();
    await settle();

    (host.querySelector("[data-redis-search-history-toggle]") as HTMLButtonElement).click();
    await settle();

    const items = [...host.querySelectorAll("[data-redis-search-history-item]")];
    const forgetUser = items.find((el) => el.textContent?.includes("user:*"))!.querySelector("[data-redis-search-history-forget]") as HTMLButtonElement;
    forgetUser.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await settle();

    expect(loadRedisKeySearchHistory({ connectionId: "connection", db: 0 })).toEqual(["cache:*"]);
    expect(host.querySelector("[data-redis-search-history-list]")?.textContent).toContain("cache:*");
    expect(host.querySelector("[data-redis-search-history-list]")?.textContent).not.toContain("user:*");
  });

  it("does not mix history across connectionId+db scopes", async () => {
    rememberRedisKeySearchHistory({ connectionId: "connection", db: 0 }, "db0:*");
    rememberRedisKeySearchHistory({ connectionId: "connection", db: 1 }, "db1:*");
    rememberRedisKeySearchHistory({ connectionId: "other", db: 0 }, "other:*");

    const host = mountBrowser({ connectionId: "connection", db: 0 });
    await settle();
    (host.querySelector("[data-redis-search-history-toggle]") as HTMLButtonElement).click();
    await settle();

    const text = host.querySelector("[data-redis-search-history-list]")?.textContent ?? "";
    expect(text).toContain("db0:*");
    expect(text).not.toContain("db1:*");
    expect(text).not.toContain("other:*");
  });

  it("keeps history and key-template menus mutually exclusive", async () => {
    rememberRedisKeySearchHistory({ connectionId: "connection", db: 0 }, "legacy:*");

    const host = mountBrowser();
    await settle();

    const input = host.querySelector("[data-redis-search-input]") as HTMLInputElement;
    input.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    await settle();
    expect(host.querySelector('[role="listbox"][aria-label="Key templates"]')).not.toBeNull();
    expect(host.querySelector("[data-redis-search-history-list]")).toBeNull();

    (host.querySelector("[data-redis-search-history-toggle]") as HTMLButtonElement).click();
    await settle();
    expect(host.querySelector("[data-redis-search-history-list]")).not.toBeNull();
    expect(host.querySelector('[role="listbox"][aria-label="Key templates"]')).toBeNull();
  });

  it("does not remember empty search submissions", async () => {
    const host = mountBrowser();
    await settle();

    const input = host.querySelector("[data-redis-search-input]") as HTMLInputElement;
    input.value = "   ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();

    expect(loadRedisKeySearchHistory({ connectionId: "connection", db: 0 })).toEqual([]);
    expect(forgetRedisKeySearchHistory({ connectionId: "connection", db: 0 }, "noop")).toEqual([]);
  });
});
