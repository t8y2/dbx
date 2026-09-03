// @vitest-environment happy-dom

import { createApp, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    getConfig: () => ({ name: "Redis", redis_key_separator: ":", redis_scan_page_size: mocks.redisScanPageSize }),
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

const mountedApps: Array<{ unmount: () => void; host: HTMLElement }> = [];

function mountBrowser() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(RedisKeyBrowser, { connectionId: "connection", db: 0, blockDangerousRedisCommands: false });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mountedApps.push({ unmount: () => app.unmount(), host });
  return host;
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

function resetApiMocks() {
  vi.clearAllMocks();
  mocks.redisScanPageSize = 100;
  mocks.infiniteScroll = false;
  mocks.queryResultMaxRowsEnabled = true;
  mocks.queryResultMaxRows = 5000;
  mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [], total_keys: 0 });
}

function keyInfo(rawKey: string): RedisKeyInfo {
  return { key_display: rawKey, key_raw: rawKey, key_type: "string", ttl: -1, size: 0, value_preview: "" };
}

// Group ids come from `buildGroupId(db, pathSegments)` in redisKeyTree.ts:
// `group:${db}:${JSON.stringify(pathSegments)}`. The checkbox carrying
// `data-redis-group` sits inside the row div with the row click handler, so a
// plain click on that row toggles expansion (same walk the infinite-scroll
// spec uses).
function groupCheckboxSelector(segments: string[]): string {
  return `[data-redis-group='group:0:${JSON.stringify(segments)}']`;
}

function expandGroup(host: HTMLElement, segments: string[]) {
  const checkbox = host.querySelector<HTMLElement>(groupCheckboxSelector(segments));
  expect(checkbox, `group row for ${segments.join(":")}`).toBeDefined();
  const row = checkbox!.closest<HTMLElement>("div.cursor-pointer");
  expect(row?.className).toContain("cursor-pointer");
  row!.click();
}

// A leaf is rendered (checkbox present) if and only if every ancestor group of
// its path is currently expanded — the observable expansion state.
function leafVisible(host: HTMLElement, keyRaw: string): boolean {
  return host.querySelector(`[data-redis-leaf='${keyRaw}']`) !== null;
}

// The toolbar refresh action: the only untitled `h-6 w-6` icon button (the
// create-key button next to it carries a title).
function clickRefresh(host: HTMLElement) {
  const refresh = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.className.includes("h-6 w-6") && !button.hasAttribute("title"));
  expect(refresh, "refresh button").toBeDefined();
  refresh!.click();
}

function clickLoadMore(host: HTMLElement) {
  const loadMore = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("redis.loadMoreKeys") && !button.disabled);
  expect(loadMore, "load more button").toBeDefined();
  loadMore!.click();
}

beforeEach(() => {
  resetApiMocks();
});

afterEach(() => {
  for (const { unmount, host } of mountedApps.splice(0)) {
    unmount();
    host.remove();
  }
});

describe("RedisKeyBrowser expansion persistence across refresh (issue #7173)", () => {
  it("keeps nested groups expanded when the key list is refreshed", async () => {
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [keyInfo("grp:sub:x"), keyInfo("grp:sub:y"), keyInfo("solo")], total_keys: 3 });

    const host = mountBrowser();
    await settle();

    expandGroup(host, ["grp"]);
    await settle();
    expandGroup(host, ["grp", "sub"]);
    await settle();
    expect(leafVisible(host, "grp:sub:x")).toBe(true);
    expect(leafVisible(host, "grp:sub:y")).toBe(true);

    clickRefresh(host);
    await settle();

    // The refresh really re-scanned and rebuilt the tree, yet the nested
    // group stayed expanded — leaves remain visible without any clicks.
    expect(mocks.redisScanKeysBatch.mock.calls.filter((call: unknown[]) => call[3] === "*").length).toBeGreaterThanOrEqual(2);
    expect(leafVisible(host, "grp:sub:x")).toBe(true);
    expect(leafVisible(host, "grp:sub:y")).toBe(true);
  });

  it("drops vanished groups, keeps surviving parents expanded, and still expands newly appeared groups", async () => {
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [keyInfo("grp:sub:x"), keyInfo("grp:other:1")], total_keys: 2 });

    const host = mountBrowser();
    await settle();

    expandGroup(host, ["grp"]);
    await settle();
    expandGroup(host, ["grp", "sub"]);
    await settle();
    expect(leafVisible(host, "grp:sub:x")).toBe(true);

    // After the refresh every `grp:sub:*` key is gone; `grp` survives with a
    // new child group and a brand-new top-level group appeared.
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [keyInfo("grp:other:1"), keyInfo("fresh:2")], total_keys: 2 });
    clickRefresh(host);
    await settle();

    // `grp` itself is still expanded, so its new child group renders directly.
    expect(host.querySelector(groupCheckboxSelector(["grp", "other"]))).not.toBeNull();
    // The vanished `grp:sub` group no longer exists in the tree at all.
    expect(host.querySelector(groupCheckboxSelector(["grp", "sub"]))).toBeNull();

    // Expanding a newly appeared group still works.
    expandGroup(host, ["fresh"]);
    await settle();
    expect(leafVisible(host, "fresh:2")).toBe(true);
  });

  it("restores expansion when a group only reappears on a later page of the same refresh", async () => {
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [keyInfo("keep:1"), keyInfo("grp:sub:x")], total_keys: 2 });

    const host = mountBrowser();
    await settle();

    expandGroup(host, ["grp"]);
    await settle();
    expandGroup(host, ["grp", "sub"]);
    await settle();
    expect(leafVisible(host, "grp:sub:x")).toBe(true);

    // Refresh: the first page misses the expanded group's keys entirely; a
    // follow-up page brings them back.
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number) => {
      if (cursor === 0) return Promise.resolve({ cursor: 7, keys: [keyInfo("keep:1")], total_keys: 2 });
      return Promise.resolve({ cursor: 0, keys: [keyInfo("grp:sub:x")], total_keys: 0 });
    });
    clickRefresh(host);
    await settle();

    // First page only: the group is not in the tree yet, so nothing to show.
    expect(host.querySelector(groupCheckboxSelector(["grp"]))).toBeNull();

    clickLoadMore(host);
    await settle();

    // The group reappeared via the merge path and was re-expanded from the
    // refresh snapshot — no user clicks needed.
    expect(leafVisible(host, "grp:sub:x")).toBe(true);
  });

  it("starts collapsed again after a scope reset even though the same keys reload", async () => {
    // `resetLoadedKeys` runs for db-flush events and the connection/db watch;
    // both must keep the old reset behavior: no expansion carry-over.
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [keyInfo("grp:sub:x")], total_keys: 1 });

    const host = mountBrowser();
    await settle();

    expandGroup(host, ["grp"]);
    await settle();
    expandGroup(host, ["grp", "sub"]);
    await settle();
    expect(leafVisible(host, "grp:sub:x")).toBe(true);

    window.dispatchEvent(new CustomEvent("dbx-redis-db-flushed", { detail: { connectionId: "connection", db: 0 } }));
    await settle();
    clickRefresh(host);
    await settle();

    // Same keys reloaded, but the tree starts collapsed again.
    expect(leafVisible(host, "grp:sub:x")).toBe(false);
    expandGroup(host, ["grp"]);
    await settle();
    expandGroup(host, ["grp", "sub"]);
    await settle();
    expect(leafVisible(host, "grp:sub:x")).toBe(true);
  });

  it("keeps flat key search rows flat and resets expansion when returning to the tree", async () => {
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [keyInfo("grp:sub:x")], total_keys: 1 });

    const host = mountBrowser();
    await settle();

    expandGroup(host, ["grp"]);
    await settle();
    expandGroup(host, ["grp", "sub"]);
    await settle();
    expect(leafVisible(host, "grp:sub:x")).toBe(true);

    // Non-fuzzy key search renders flat rows: the full key is visible without
    // expanding anything (pre-existing behavior, unaffected by this change).
    const input = host.querySelector<HTMLInputElement>("[data-redis-search-input]")!;
    input.value = "sub";
    input.dispatchEvent(new Event("input"));
    await nextTick();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();

    expect(leafVisible(host, "grp:sub:x")).toBe(true);

    // Escape clears the pattern and returns to the hierarchical tree, which
    // still starts collapsed after leaving flat search mode.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();

    expect(leafVisible(host, "grp:sub:x")).toBe(false);
    expandGroup(host, ["grp"]);
    await settle();
    expandGroup(host, ["grp", "sub"]);
    await settle();
    expect(leafVisible(host, "grp:sub:x")).toBe(true);
  });

  it("refreshing an empty database does not error", async () => {
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [], total_keys: 0 });

    const host = mountBrowser();
    await settle();
    expect(host.textContent).toContain("redis.noKeys");

    clickRefresh(host);
    await settle();

    expect(host.textContent).toContain("redis.noKeys");
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
