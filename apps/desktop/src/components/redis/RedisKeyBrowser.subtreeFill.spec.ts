// @vitest-environment happy-dom

import { createApp, defineComponent, h, KeepAlive, nextTick, ref } from "vue";
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
  redisSetKeysTtl: vi.fn(),
  redisSetKeysExpireAt: vi.fn(),
  redisCheckJsonModule: vi.fn(),
  redisDeleteKey: vi.fn(),
  redisDeleteKeys: vi.fn(),
  redisDeleteKeysByPattern: vi.fn(),
  redisExecuteCommand: vi.fn(),
  saveHistory: vi.fn(),
  toast: vi.fn(),
  updateRedisDbKeyStats: vi.fn(),
  listRedisCompletionCommandDocs: vi.fn(),
  listRedisCompletionKeys: vi.fn(),
  redisScanPageSize: 100,
  separator: ":",
  keyFilter: "",
  infiniteScroll: true,
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
  redisSetKeysTtl: mocks.redisSetKeysTtl,
  redisSetKeysExpireAt: mocks.redisSetKeysExpireAt,
  redisCheckJsonModule: mocks.redisCheckJsonModule,
  redisDeleteKey: mocks.redisDeleteKey,
  redisDeleteKeys: mocks.redisDeleteKeys,
  redisDeleteKeysByPattern: mocks.redisDeleteKeysByPattern,
  redisExecuteCommand: mocks.redisExecuteCommand,
  saveHistory: mocks.saveHistory,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: () => ({ name: "Redis", redis_key_separator: mocks.separator, redis_key_filter: mocks.keyFilter, redis_scan_page_size: mocks.redisScanPageSize }),
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
  return {
    default: defineComponent({
      props: { keyRaw: String, metadata: Object },
      emits: ["deleted", "renamed", "loaded"],
      setup(props, { emit }) {
        return () =>
          h("div", [
            h("output", { "data-viewer-metadata": "" }, JSON.stringify(props.metadata)),
            h("button", { "data-viewer-delete": "", onClick: () => emit("deleted", props.keyRaw) }),
            h("button", { "data-viewer-rename": "", onClick: () => emit("renamed", props.keyRaw, "grp:renamed", "grp:renamed") }),
            h("button", { "data-viewer-loaded": "", onClick: () => emit("loaded", { key_raw: props.keyRaw, key_display: props.metadata?.key_display, redis_type: "string", ttl: 120, data: { kind: "string", content: { display: "updated", raw_base64: "dXBkYXRlZA==", encoding: "utf8" } } }) }),
          ]);
      },
    }),
  };
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
      setup(props, { attrs, slots, expose }) {
        const visibleItemCount = 50;
        expose({ scrollToItem: () => undefined });
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
    host,
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

async function settleThoroughly(rounds = 40) {
  for (let i = 0; i < rounds; i++) await settle();
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
  mocks.redisScanKeysBatch.mockReset();
  mocks.redisScanPageSize = 100;
  mocks.separator = ":";
  mocks.keyFilter = "";
  mocks.infiniteScroll = true;
  mocks.queryResultMaxRowsEnabled = true;
  mocks.queryResultMaxRows = 5000;
  mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [], total_keys: 0 });
}

// Overflowing viewport (see the infinite-scroll spec): rows render while the
// bounded auto-fill stays off, so subtree scans fire only from explicit group
// expansion and explicit "Load more" clicks — deterministic call counts.
let originalClientHeight: PropertyDescriptor | undefined;
let originalScrollHeight: PropertyDescriptor | undefined;

function stubOverflowingViewport() {
  originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("redis-key-scroller") ? 1000 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("redis-key-scroller") ? 5000 : 100;
    },
  });
}

function restoreViewportStub() {
  if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
}

function keyInfo(rawKey: string): RedisKeyInfo {
  return { key_display: rawKey, key_raw: rawKey, key_type: "string", ttl: -1, size: 0, value_preview: "" };
}

function subtreeBatchKeys(count: number, batch: number): RedisKeyInfo[] {
  return Array.from({ length: count }, (_, index) => keyInfo(`grp:batch${batch}:${index}`));
}

// `cursor` (3rd arg) and `pattern` (4th arg) of every subtree fill call.
function subtreeCalls(): unknown[][] {
  return mocks.redisScanKeysBatch.mock.calls.filter((call: unknown[]) => call[3] === "grp:*");
}

// Clicks the group row itself (the checkbox consumes its own clicks; walk up to
// the row div carrying the click handler — same walk as the infinite-scroll
// spec).
function expandFirstGroupRow(host: HTMLElement) {
  const checkbox = host.querySelector<HTMLElement>("[data-redis-group]");
  const row = checkbox?.parentElement?.parentElement;
  expect(row?.className).toContain("cursor-pointer");
  row!.click();
}

function clickLoadMore(host: HTMLElement) {
  const loadMore = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("redis.loadMoreKeys") && !button.disabled);
  expect(loadMore, "load more button").toBeDefined();
  loadMore!.click();
}

function leafVisible(host: HTMLElement, keyRaw: string): boolean {
  return host.querySelector(`[data-redis-leaf='${keyRaw}']`) !== null;
}

// Mirrors `SUBTREE_FILL_MAX_NEW_KEYS` / `SUBTREE_FILL_MAX_SCAN_ITERATIONS` /
// `SUBTREE_SCAN_ITERATIONS_PER_CALL` in RedisKeyBrowser.vue: one fill pass
// merges at most 500 new keys and spends at most 50 SCAN iterations in batches
// of 8 — whichever bound hits first. At the spec's page size of 100 the key
// bound needs 5 calls; the iteration bound alone needs 7.
const SUBTREE_FILL_MAX_CALLS_BY_KEYS = 5;
const SUBTREE_FILL_MAX_CALLS_BY_ITERATIONS = 7;

function groupCheckbox(host: HTMLElement, path: string[], db = 0): HTMLInputElement {
  const checkbox = Array.from(host.querySelectorAll<HTMLInputElement>("[data-redis-group]")).find((element) => element.dataset.redisGroup === `group:${db}:${JSON.stringify(path)}`);
  expect(checkbox, `group ${path.join(":")}`).toBeDefined();
  return checkbox!;
}

function refreshGroupButton(host: HTMLElement, path = ["grp"]): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>("[data-redis-refresh-group]")).find((element) => element.dataset.redisRefreshGroup === `group:0:${JSON.stringify(path)}`);
  expect(button, `refresh action for ${path.join(":")}`).toBeDefined();
  return button!;
}

describe("RedisKeyBrowser prefix refresh (issue #13028)", () => {
  beforeEach(stubOverflowingViewport);

  function completeTree(keys = ["grp:old", "grp:keep", "other:keep"]) {
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: keys.map(keyInfo), total_keys: keys.length });
  }

  it("replaces only the refreshed prefix and preserves sibling expansion and checked keys", async () => {
    completeTree(["grp:old", "grp:keep", "grp:child:keep", "other:keep"]);
    const host = mountBrowser();
    await settleThoroughly();
    expandFirstGroupRow(host);
    await settleThoroughly();
    groupCheckbox(host, ["grp", "child"]).parentElement!.parentElement!.click();
    groupCheckbox(host, ["other"]).parentElement!.parentElement!.click();
    await settleThoroughly();
    host.querySelector<HTMLInputElement>("[data-redis-leaf='other:keep']")!.click();
    host.querySelector<HTMLInputElement>("[data-redis-leaf='grp:old']")!.click();
    await settleThoroughly();

    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [keyInfo("grp:keep"), keyInfo("grp:new"), keyInfo("grp:child:keep")], total_keys: 4 });
    refreshGroupButton(host).click();
    await settleThoroughly();

    expect(leafVisible(host, "grp:old")).toBe(false);
    expect(leafVisible(host, "grp:new")).toBe(true);
    expect(leafVisible(host, "grp:keep")).toBe(true);
    expect(leafVisible(host, "grp:child:keep")).toBe(true);
    expect(host.querySelector<HTMLInputElement>("[data-redis-leaf='other:keep']")?.checked).toBe(true);
    expect(host.textContent).toContain("redis.deselectAll");
    expect(mocks.redisScanKeysBatch).toHaveBeenLastCalledWith("connection", 0, 0, "grp:*", 100, 8, true);
  });

  it("removes an expired empty prefix without touching a neighboring prefix", async () => {
    completeTree(["grp:old", "grp2:keep"]);
    const host = mountBrowser();
    await settleThoroughly();
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [], total_keys: 1 });
    refreshGroupButton(host).click();
    await settleThoroughly();
    expect(host.querySelectorAll("[data-redis-group]")).toHaveLength(1);
    groupCheckbox(host, ["grp2"]).parentElement!.parentElement!.click();
    await settleThoroughly();
    expect(leafVisible(host, "grp2:keep")).toBe(true);
  });

  it("refreshes metadata of existing keys", async () => {
    completeTree(["grp:keep"]);
    const host = mountBrowser();
    await settleThoroughly();
    expandFirstGroupRow(host);
    await settleThoroughly();
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [{ ...keyInfo("grp:keep"), key_type: "hash", ttl: 3600 }], total_keys: 1 });
    refreshGroupButton(host).click();
    await settleThoroughly();
    const row = host.querySelector("[data-redis-key-raw='grp:keep']")!;
    expect(row.textContent).toContain("hash");
    expect(row.textContent).not.toContain("string");
    expect(row.textContent).not.toContain("redis.noExpiry");
  });

  it("retains the previous tree on failure and retries the prefix", async () => {
    completeTree();
    const host = mountBrowser();
    await settleThoroughly();
    expandFirstGroupRow(host);
    await settleThoroughly();
    mocks.redisScanKeysBatch.mockRejectedValueOnce(new Error("prefix scan failed"));
    refreshGroupButton(host).click();
    await settleThoroughly();
    expect(leafVisible(host, "grp:old")).toBe(true);
    expect(mocks.toast).toHaveBeenCalledWith("prefix scan failed", 5000);
    expect(refreshGroupButton(host).disabled).toBe(false);
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [keyInfo("grp:retry")], total_keys: 2 });
    refreshGroupButton(host).click();
    await settleThoroughly();
    expect(leafVisible(host, "grp:retry")).toBe(true);
    expect(leafVisible(host, "grp:old")).toBe(false);
  });

  it("bounds sparse refreshes and keeps old keys until explicit continuation completes", async () => {
    completeTree();
    const host = mountBrowser();
    await settleThoroughly();
    expandFirstGroupRow(host);
    await settleThoroughly();
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number) => Promise.resolve({ cursor: cursor + 1, keys: [], total_keys: 3 }));
    refreshGroupButton(host).click();
    await settleThoroughly();
    expect(subtreeCalls()).toHaveLength(7);
    expect(leafVisible(host, "grp:old")).toBe(true);
    expect(refreshGroupButton(host).title).toBe("redis.loadMoreKeys");
    await settleThoroughly();
    expect(subtreeCalls()).toHaveLength(7);
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [keyInfo("grp:fresh")], total_keys: 2 });
    refreshGroupButton(host).click();
    await settleThoroughly();
    expect(subtreeCalls()[7][2]).toBe(7);
    expect(leafVisible(host, "grp:fresh")).toBe(true);
    expect(leafVisible(host, "grp:old")).toBe(false);
  });

  it("bounds dense refreshes and preserves buffered results across passes", async () => {
    completeTree();
    const host = mountBrowser();
    await settleThoroughly();
    let page = 0;
    mocks.redisScanKeysBatch.mockImplementation(() => Promise.resolve({ cursor: ++page, keys: subtreeBatchKeys(100, page), total_keys: 1000 }));
    refreshGroupButton(host).click();
    await settleThoroughly();
    expect(subtreeCalls()).toHaveLength(5);
    expect(host.textContent).toContain("(2)");
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [keyInfo("grp:last")], total_keys: 502 });
    refreshGroupButton(host).click();
    await settleThoroughly();
    expect(subtreeCalls()[5][2]).toBe(5);
    expect(host.textContent).toContain("(501)");
  });

  it("escapes literal prefixes with a custom separator and honors the connection scope", async () => {
    mocks.separator = "/";
    mocks.keyFilter = "g*/*keep*";
    completeTree(["g[1]/keep-old"]);
    const host = mountBrowser();
    await settleThoroughly();
    groupCheckbox(host, ["g[1]"]).parentElement!.parentElement!.click();
    await settleThoroughly();
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [keyInfo("g[1]/keep-new"), keyInfo("g[1]/hidden")], total_keys: 2 });
    refreshGroupButton(host, ["g[1]"]).click();
    await settleThoroughly();
    expect(mocks.redisScanKeysBatch).toHaveBeenLastCalledWith("connection", 0, 0, "g\\[1\\]/*", 100, 8, true);
    expect(leafVisible(host, "g[1]/keep-new")).toBe(true);
    expect(leafVisible(host, "g[1]/hidden")).toBe(false);
  });

  it("disables duplicate refresh clicks and discards late results after KeepAlive deactivation", async () => {
    completeTree();
    const browser = mountKeptAliveBrowser();
    await settleThoroughly();
    expandFirstGroupRow(browser.host);
    await settleThoroughly();
    const pending = deferred<{ cursor: number; keys: RedisKeyInfo[]; total_keys: number }>();
    mocks.redisScanKeysBatch.mockReturnValue(pending.promise);
    refreshGroupButton(browser.host).click();
    await settleThoroughly();
    expect(refreshGroupButton(browser.host).disabled).toBe(true);
    refreshGroupButton(browser.host).click();
    expect(subtreeCalls()).toHaveLength(1);
    await browser.deactivate();
    pending.resolve({ cursor: 0, keys: [keyInfo("grp:late")], total_keys: 1 });
    await settleThoroughly();
    await browser.activate();
    await settleThoroughly();
    expect(leafVisible(browser.host, "grp:old")).toBe(true);
    expect(leafVisible(browser.host, "grp:late")).toBe(false);
    expect(refreshGroupButton(browser.host).disabled).toBe(false);
  });

  it("does not change the main scan cursor when refreshing a partial tree", async () => {
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, _cursor: number, pattern: string) => Promise.resolve({ cursor: pattern === "*" ? 91 : 0, keys: [keyInfo("grp:keep")], total_keys: 1000 }));
    const host = mountBrowser();
    await settleThoroughly();
    refreshGroupButton(host).click();
    await settleThoroughly();
    clickLoadMore(host);
    await settleThoroughly();
    const mainCalls = mocks.redisScanKeysBatch.mock.calls.filter((call: unknown[]) => call[3] === "*");
    expect(mainCalls[1][2]).toBe(91);
  });

  it("keeps nonmatching cached keys when refreshing a locally searched full snapshot", async () => {
    mocks.redisScanKeysBatch.mockResolvedValueOnce({ cursor: 91, keys: [keyInfo("grp:keep-old"), keyInfo("grp:hidden")], total_keys: 2 });
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [], total_keys: 0 });
    const host = mountBrowser();
    await settleThoroughly();
    Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("redis.fetchAllKeys"))!
      .click();
    await settleThoroughly();
    host.querySelector<HTMLButtonElement>("button[title='redis.fuzzyMatchTitle']")!.click();
    await settleThoroughly();
    const input = host.querySelector<HTMLInputElement>("input[placeholder='redis.fuzzyPattern']")!;
    input.value = "keep";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settleThoroughly();
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [keyInfo("grp:keep-new"), keyInfo("grp:hidden")], total_keys: 2 });
    refreshGroupButton(host).click();
    await settleThoroughly();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settleThoroughly();
    expandFirstGroupRow(host);
    await settleThoroughly();
    expect(leafVisible(host, "grp:hidden")).toBe(true);
  });

  it.each(["resolves", "rejects"])("ignores an old prefix refresh that %s after switching databases", async (outcome) => {
    completeTree();
    const db = ref(0);
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(defineComponent({ setup: () => () => h(RedisKeyBrowser, { connectionId: "connection", db: db.value, blockDangerousRedisCommands: false }) }));
    app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
    app.mount(host);
    mountedApps.push({ unmount: () => app.unmount(), host });
    await settleThoroughly();
    const pending = deferred<{ cursor: number; keys: RedisKeyInfo[]; total_keys: number }>();
    mocks.redisScanKeysBatch.mockReturnValueOnce(pending.promise);
    refreshGroupButton(host).click();
    await settleThoroughly();
    completeTree(["db1:keep"]);
    db.value = 1;
    await settleThoroughly();
    if (outcome === "resolves") pending.resolve({ cursor: 0, keys: [keyInfo("grp:late")], total_keys: 1 });
    else pending.reject(new Error("late failure"));
    await settleThoroughly();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(host.querySelectorAll("[data-redis-group]")).toHaveLength(1);
    groupCheckbox(host, ["db1"], 1).parentElement!.parentElement!.click();
    await settleThoroughly();
    expect(leafVisible(host, "db1:keep")).toBe(true);
    expect(leafVisible(host, "grp:late")).toBe(false);
  });

  it("retains unrelated groups' pending subtree cursors after refreshing a prefix", async () => {
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number, pattern: string) => {
      if (pattern === "other:*") return Promise.resolve({ cursor: cursor + 1, keys: [], total_keys: 0 });
      if (pattern === "grp:*") return Promise.resolve({ cursor: 0, keys: [keyInfo("grp:new")], total_keys: 1000 });
      return Promise.resolve({ cursor: 91, keys: [keyInfo("grp:old"), keyInfo("other:keep")], total_keys: 1000 });
    });
    const host = mountBrowser();
    await settleThoroughly();
    groupCheckbox(host, ["other"]).parentElement!.parentElement!.click();
    await settleThoroughly();
    refreshGroupButton(host).click();
    await settleThoroughly();
    clickLoadMore(host);
    await settleThoroughly();
    const otherCalls = mocks.redisScanKeysBatch.mock.calls.filter((call: unknown[]) => call[3] === "other:*");
    expect(otherCalls).toHaveLength(14);
    expect(otherCalls[7][2]).toBe(7);
  });

  it("publishes refreshed metadata to the surviving selected detail viewer", async () => {
    completeTree(["grp:keep"]);
    const host = mountBrowser();
    await settleThoroughly();
    expandFirstGroupRow(host);
    await settleThoroughly();
    host.querySelector<HTMLElement>("[data-redis-key-raw='grp:keep']")!.click();
    await settleThoroughly();
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [{ ...keyInfo("grp:keep"), size: 99, ttl: 120 }], total_keys: 1 });
    refreshGroupButton(host).click();
    await settleThoroughly();
    const metadata = JSON.parse(host.querySelector("[data-viewer-metadata]")!.textContent!);
    expect(metadata.size).toBe(99);
    expect(metadata.ttl).toBe(120);
  });

  it.each(["delete", "rename", "loaded"])("discards buffered prefix records after a confirmed detail %s", async (action) => {
    completeTree();
    const host = mountBrowser();
    await settleThoroughly();
    expandFirstGroupRow(host);
    await settleThoroughly();
    host.querySelector<HTMLElement>("[data-redis-key-raw='grp:old']")!.click();
    await settleThoroughly();
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number) => Promise.resolve({ cursor: cursor + 1, keys: [keyInfo("grp:old")], total_keys: 3 }));
    refreshGroupButton(host).click();
    await settleThoroughly();
    expect(refreshGroupButton(host).title).toBe("redis.loadMoreKeys");
    host.querySelector<HTMLButtonElement>(`[data-viewer-${action}]`)!.click();
    await settleThoroughly();
    expect(refreshGroupButton(host).title).toBe("common.refresh");
    const keys = action === "delete" ? [keyInfo("grp:keep")] : action === "rename" ? [keyInfo("grp:keep"), keyInfo("grp:renamed")] : [{ ...keyInfo("grp:old"), ttl: 120 }];
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys, total_keys: 2 });
    refreshGroupButton(host).click();
    await settleThoroughly();
    expect(subtreeCalls()[7][2]).toBe(0);
    if (action !== "loaded") expect(leafVisible(host, "grp:old")).toBe(false);
    else expect(host.querySelector("[data-redis-key-raw='grp:old']")!.textContent).not.toContain("redis.noExpiry");
  });
});

beforeEach(() => {
  resetApiMocks();
});

afterEach(() => {
  for (const { unmount, host } of mountedApps.splice(0)) {
    unmount();
    host.remove();
  }
  restoreViewportStub();
});

// Issue #7918: expanding a group with a huge prefix (e.g. 10000 `xxxx::xxxx`
// keys) used to scan the subtree to exhaustion in one interaction, freezing
// the Redis cluster. A fill pass must stay bounded regardless of subtree size,
// keep its scan cursor, and resume on demand — while small groups still fill
// completely in one pass.
describe("RedisKeyBrowser bounded group subtree fill (issue #7918)", () => {
  beforeEach(() => {
    mocks.redisScanPageSize = 100;
  });

  function mockMainScanOpen() {
    // First browse page seeds one `grp` key; every continuation keeps the main
    // scan open (cursor never closes), so the tree stays partial and subtree
    // fills remain eligible.
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number, pattern: string) => {
      if (pattern === "grp:*") return Promise.resolve({ cursor: 0, keys: [], total_keys: 0 });
      if (cursor === 0) return Promise.resolve({ cursor: 9, keys: [keyInfo("grp:a")], total_keys: 10_000 });
      return Promise.resolve({ cursor: 9, keys: [], total_keys: 0 });
    });
  }

  it("fills a small group's subtree completely in one pass and does not refill on re-expand", async () => {
    stubOverflowingViewport();
    mockMainScanOpen();
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number, pattern: string) => {
      if (pattern === "grp:*") return Promise.resolve({ cursor: 0, keys: [keyInfo("grp:s1"), keyInfo("grp:s2"), keyInfo("grp:s3")], total_keys: 0 });
      if (cursor === 0) return Promise.resolve({ cursor: 9, keys: [keyInfo("grp:a")], total_keys: 10_000 });
      return Promise.resolve({ cursor: 9, keys: [], total_keys: 0 });
    });

    const host = mountBrowser();
    await settleThoroughly();

    expandFirstGroupRow(host);
    await settleThoroughly();

    // The whole subtree arrived in a single call (cursor closed immediately).
    expect(subtreeCalls().length).toBe(1);
    expect(leafVisible(host, "grp:s1")).toBe(true);
    expect(leafVisible(host, "grp:s3")).toBe(true);

    // Fully scanned: collapse + re-expand must not rescan the subtree.
    expandFirstGroupRow(host);
    await settleThoroughly();
    expandFirstGroupRow(host);
    await settleThoroughly();
    expect(subtreeCalls().length).toBe(1);
    expect(leafVisible(host, "grp:s1")).toBe(true);
  });

  it("stops a huge group's fill at the per-pass key cap, saves the cursor, and scans no further", async () => {
    stubOverflowingViewport();
    let subtreeCall = 0;
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number, pattern: string) => {
      if (pattern === "grp:*") {
        subtreeCall++;
        // A full page of brand-new keys every call; the cursor never closes.
        return Promise.resolve({ cursor: 2000 + subtreeCall, keys: subtreeBatchKeys(100, subtreeCall), total_keys: 0 });
      }
      if (cursor === 0) return Promise.resolve({ cursor: 9, keys: [keyInfo("grp:a")], total_keys: 10_000 });
      return Promise.resolve({ cursor: 9, keys: [], total_keys: 0 });
    });

    const host = mountBrowser();
    await settleThoroughly();
    expect(subtreeCalls().length).toBe(0);

    expandFirstGroupRow(host);
    await settleThoroughly();

    // 1 main-scan key + 5 × 100 subtree keys = 500 new keys merged: exactly the
    // per-pass cap, reached after 5 subtree calls — never a scan to exhaustion
    // no matter how huge the prefix is.
    expect(subtreeCalls().length).toBe(SUBTREE_FILL_MAX_CALLS_BY_KEYS);
    expect(host.textContent).toContain("(501+)");

    // Nothing else drives the fill: settling further must not scan any more.
    const callsAtCap = subtreeCalls().length;
    await settleThoroughly(10);
    expect(subtreeCalls().length).toBe(callsAtCap);
  });

  it("bounds a sparse subtree fill by the SCAN iteration budget even when no keys match", async () => {
    stubOverflowingViewport();
    mockMainScanOpen();
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number, pattern: string) => {
      // The prefix matches almost nothing in a huge keyspace: every call comes
      // back empty with a cursor that keeps advancing, so the key cap never
      // fires — only the iteration budget can stop this pass.
      if (pattern === "grp:*") return Promise.resolve({ cursor: cursor + 1, keys: [], total_keys: 0 });
      if (cursor === 0) return Promise.resolve({ cursor: 9, keys: [keyInfo("grp:a")], total_keys: 10_000 });
      return Promise.resolve({ cursor: 9, keys: [], total_keys: 0 });
    });

    const host = mountBrowser();
    await settleThoroughly();

    expandFirstGroupRow(host);
    await settleThoroughly();

    // 50 iterations spent in batches of 8 = 6 full calls + 1 final call of 2.
    const calls = subtreeCalls();
    expect(calls.length).toBe(SUBTREE_FILL_MAX_CALLS_BY_ITERATIONS);
    expect(calls[6][5]).toBe(2);
    await settleThoroughly(10);
    expect(subtreeCalls().length).toBe(SUBTREE_FILL_MAX_CALLS_BY_ITERATIONS);
  });

  it("resumes a partially filled subtree from its saved cursor via Load more and completes", async () => {
    stubOverflowingViewport();
    let subtreeCall = 0;
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number, pattern: string) => {
      if (pattern === "grp:*") {
        subtreeCall++;
        // 5 capped batches, then the resumed pass finds the subtree exhausted.
        if (subtreeCall <= SUBTREE_FILL_MAX_CALLS_BY_KEYS) return Promise.resolve({ cursor: 2000 + subtreeCall, keys: subtreeBatchKeys(100, subtreeCall), total_keys: 0 });
        return Promise.resolve({ cursor: 0, keys: subtreeBatchKeys(50, subtreeCall), total_keys: 0 });
      }
      if (cursor === 0) return Promise.resolve({ cursor: 9, keys: [keyInfo("grp:a")], total_keys: 10_000 });
      return Promise.resolve({ cursor: 9, keys: [], total_keys: 0 });
    });

    const host = mountBrowser();
    await settleThoroughly();

    expandFirstGroupRow(host);
    await settleThoroughly();
    expect(subtreeCalls().length).toBe(SUBTREE_FILL_MAX_CALLS_BY_KEYS);

    // "Load more" advances the main scan and, alongside it, resumes the next
    // pending subtree — continuing from the cursor the capped pass saved (the
    // one returned by call 5), never rescanning from 0.
    clickLoadMore(host);
    await settleThoroughly();

    expect(subtreeCalls().length).toBe(SUBTREE_FILL_MAX_CALLS_BY_KEYS + 1);
    const resumeCall = subtreeCalls()[SUBTREE_FILL_MAX_CALLS_BY_KEYS];
    expect(resumeCall[2]).toBe(2000 + SUBTREE_FILL_MAX_CALLS_BY_KEYS);

    // The subtree is now exhausted: re-expanding must not rescan it.
    expandFirstGroupRow(host);
    await settleThoroughly();
    expandFirstGroupRow(host);
    await settleThoroughly();
    expect(subtreeCalls().length).toBe(SUBTREE_FILL_MAX_CALLS_BY_KEYS + 1);
    expect(leafVisible(host, "grp:a")).toBe(true);
  });

  it("rotates Load more continuation between pending expanded subtrees", async () => {
    stubOverflowingViewport();
    const callsByGroup = { aa: 0, bb: 0 };
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number, pattern: string) => {
      if (pattern === "aa:*" || pattern === "bb:*") {
        callsByGroup[pattern === "aa:*" ? "aa" : "bb"]++;
        return Promise.resolve({ cursor: cursor + 1, keys: [], total_keys: 0 });
      }
      if (cursor === 0) return Promise.resolve({ cursor: 9, keys: [keyInfo("aa:a"), keyInfo("bb:a")], total_keys: 10_000 });
      return Promise.resolve({ cursor: 9, keys: [], total_keys: 0 });
    });

    const host = mountBrowser();
    await settleThoroughly();
    host.querySelectorAll<HTMLElement>("[data-redis-group]")[0]!.parentElement!.parentElement!.click();
    await settleThoroughly();
    host.querySelectorAll<HTMLElement>("[data-redis-group]")[1]!.parentElement!.parentElement!.click();
    await settleThoroughly();
    expect(callsByGroup).toEqual({ aa: 7, bb: 7 });

    clickLoadMore(host);
    await settleThoroughly();
    expect(callsByGroup).toEqual({ aa: 14, bb: 7 });
    clickLoadMore(host);
    await settleThoroughly();
    expect(callsByGroup).toEqual({ aa: 14, bb: 14 });

    // Each resumed group retains its own completed pass's cursor.
    for (const pattern of ["aa:*", "bb:*"]) {
      const calls = mocks.redisScanKeysBatch.mock.calls.filter((call: unknown[]) => call[3] === pattern);
      expect(calls[SUBTREE_FILL_MAX_CALLS_BY_ITERATIONS][2]).toBe(SUBTREE_FILL_MAX_CALLS_BY_ITERATIONS);
    }
  });

  it("resumes a partially filled subtree when the group is re-expanded", async () => {
    stubOverflowingViewport();
    let subtreeCall = 0;
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number, pattern: string) => {
      if (pattern === "grp:*") {
        subtreeCall++;
        if (subtreeCall <= SUBTREE_FILL_MAX_CALLS_BY_KEYS) return Promise.resolve({ cursor: 3000 + subtreeCall, keys: subtreeBatchKeys(100, subtreeCall), total_keys: 0 });
        return Promise.resolve({ cursor: 0, keys: subtreeBatchKeys(10, subtreeCall), total_keys: 0 });
      }
      if (cursor === 0) return Promise.resolve({ cursor: 9, keys: [keyInfo("grp:a")], total_keys: 10_000 });
      return Promise.resolve({ cursor: 9, keys: [], total_keys: 0 });
    });

    const host = mountBrowser();
    await settleThoroughly();

    expandFirstGroupRow(host);
    await settleThoroughly();
    expect(subtreeCalls().length).toBe(SUBTREE_FILL_MAX_CALLS_BY_KEYS);

    // Collapse + re-expand the partially filled group: the fill resumes from
    // the saved cursor (returned by call 5) instead of restarting at 0.
    expandFirstGroupRow(host);
    await settleThoroughly();
    expandFirstGroupRow(host);
    await settleThoroughly();

    expect(subtreeCalls().length).toBe(SUBTREE_FILL_MAX_CALLS_BY_KEYS + 1);
    expect(subtreeCalls()[SUBTREE_FILL_MAX_CALLS_BY_KEYS][2]).toBe(3000 + SUBTREE_FILL_MAX_CALLS_BY_KEYS);
  });

  it("does not resume a collapsed pending subtree from a main Load more", async () => {
    stubOverflowingViewport();
    let subtreeCall = 0;
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number, pattern: string) => {
      if (pattern === "grp:*") {
        subtreeCall++;
        return Promise.resolve({ cursor: 4000 + subtreeCall, keys: subtreeBatchKeys(100, subtreeCall), total_keys: 0 });
      }
      if (cursor === 0) return Promise.resolve({ cursor: 9, keys: [keyInfo("grp:a")], total_keys: 10_000 });
      return Promise.resolve({ cursor: 9, keys: [], total_keys: 0 });
    });

    const host = mountBrowser();
    await settleThoroughly();
    expandFirstGroupRow(host);
    await settleThoroughly();
    expect(subtreeCalls()).toHaveLength(SUBTREE_FILL_MAX_CALLS_BY_KEYS);

    expandFirstGroupRow(host);
    clickLoadMore(host);
    await settleThoroughly();
    expect(subtreeCalls()).toHaveLength(SUBTREE_FILL_MAX_CALLS_BY_KEYS);

    expandFirstGroupRow(host);
    await settleThoroughly();
    expect(subtreeCalls()[SUBTREE_FILL_MAX_CALLS_BY_KEYS]?.[2]).toBe(4000 + SUBTREE_FILL_MAX_CALLS_BY_KEYS);
  });

  it("does not grant a pending subtree another pass from automatic main fill", async () => {
    stubOverflowingViewport();
    let mainCalls = 0;
    let subtreeCall = 0;
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number, pattern: string) => {
      if (pattern === "grp:*") {
        subtreeCall++;
        return Promise.resolve({ cursor: 5000 + subtreeCall, keys: subtreeBatchKeys(100, subtreeCall), total_keys: 0 });
      }
      mainCalls++;
      if (cursor === 0) return Promise.resolve({ cursor: 9, keys: [keyInfo("grp:a")], total_keys: 5_000_000 });
      return Promise.resolve({ cursor: cursor + 1, keys: [], total_keys: 0 });
    });

    const host = mountBrowser();
    await settleThoroughly();
    expandFirstGroupRow(host);
    await settleThoroughly();
    expect(subtreeCalls()).toHaveLength(SUBTREE_FILL_MAX_CALLS_BY_KEYS);

    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("redis-key-scroller") ? 90 : 100;
      },
    });
    host.querySelector(".redis-key-scroller")?.dispatchEvent(new Event("resize"));
    await settleThoroughly();

    expect(mainCalls).toBeGreaterThan(1);
    expect(subtreeCalls()).toHaveLength(SUBTREE_FILL_MAX_CALLS_BY_KEYS);
  });

  it("retains the last applied subtree cursor when KeepAlive invalidates an in-flight resume", async () => {
    stubOverflowingViewport();
    const inFlightResume = deferred<{ cursor: number; keys: RedisKeyInfo[]; total_keys: number }>();
    let subtreeCall = 0;
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number, pattern: string) => {
      if (pattern === "grp:*") {
        subtreeCall++;
        if (subtreeCall <= SUBTREE_FILL_MAX_CALLS_BY_KEYS) {
          return Promise.resolve({ cursor: 6000 + subtreeCall, keys: subtreeBatchKeys(100, subtreeCall), total_keys: 0 });
        }
        if (subtreeCall === SUBTREE_FILL_MAX_CALLS_BY_KEYS + 1) return inFlightResume.promise;
        return Promise.resolve({ cursor: 0, keys: [keyInfo("grp:resumed")], total_keys: 0 });
      }
      if (cursor === 0) return Promise.resolve({ cursor: 9, keys: [keyInfo("grp:a")], total_keys: 10_000 });
      return Promise.resolve({ cursor: 9, keys: [], total_keys: 0 });
    });

    const browser = mountKeptAliveBrowser();
    await settleThoroughly();
    expandFirstGroupRow(browser.host);
    await settleThoroughly();
    expect(subtreeCalls()).toHaveLength(SUBTREE_FILL_MAX_CALLS_BY_KEYS);

    clickLoadMore(browser.host);
    await vi.waitFor(() => expect(subtreeCalls()).toHaveLength(SUBTREE_FILL_MAX_CALLS_BY_KEYS + 1));
    expect(subtreeCalls()[SUBTREE_FILL_MAX_CALLS_BY_KEYS]?.[2]).toBe(6000 + SUBTREE_FILL_MAX_CALLS_BY_KEYS);

    await browser.deactivate();
    inFlightResume.resolve({ cursor: 7000, keys: [keyInfo("grp:stale")], total_keys: 0 });
    await settleThoroughly();
    await browser.activate();

    expandFirstGroupRow(browser.host);
    expandFirstGroupRow(browser.host);
    await vi.waitFor(() => expect(subtreeCalls()).toHaveLength(SUBTREE_FILL_MAX_CALLS_BY_KEYS + 2));
    expect(subtreeCalls()[SUBTREE_FILL_MAX_CALLS_BY_KEYS + 1]?.[2]).toBe(6000 + SUBTREE_FILL_MAX_CALLS_BY_KEYS);
    expect(leafVisible(browser.host, "grp:stale")).toBe(false);
  });

  it("stops an active subtree after collapse and resumes from its in-flight cursor", async () => {
    stubOverflowingViewport();
    const firstSubtreePage = deferred<{ cursor: number; keys: RedisKeyInfo[]; total_keys: number }>();
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number, pattern: string) => {
      if (pattern === "grp:*" && cursor === 0) return firstSubtreePage.promise;
      if (pattern === "grp:*") return Promise.resolve({ cursor: 0, keys: [keyInfo("grp:resumed")], total_keys: 0 });
      if (cursor === 0) return Promise.resolve({ cursor: 9, keys: [keyInfo("grp:a")], total_keys: 10_000 });
      return Promise.resolve({ cursor: 9, keys: [], total_keys: 0 });
    });

    const host = mountBrowser();
    await settleThoroughly();
    expandFirstGroupRow(host);
    await vi.waitFor(() => expect(subtreeCalls()).toHaveLength(1));
    expandFirstGroupRow(host);
    firstSubtreePage.resolve({ cursor: 57, keys: [], total_keys: 0 });
    await settleThoroughly();
    expect(subtreeCalls()).toHaveLength(1);

    expandFirstGroupRow(host);
    await settleThoroughly();
    expect(subtreeCalls()).toHaveLength(2);
    expect(subtreeCalls()[1]?.[2]).toBe(57);
  });

  it.each(["resolves", "rejects"] as const)("keeps a newer same-group fill owned when a stale fill %s", async (outcome) => {
    stubOverflowingViewport();
    const oldFill = deferred<{ cursor: number; keys: RedisKeyInfo[]; total_keys: number }>();
    const currentFill = deferred<{ cursor: number; keys: RedisKeyInfo[]; total_keys: number }>();
    let mainCalls = 0;
    let subtreeCall = 0;
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, _cursor: number, pattern: string) => {
      if (pattern === "grp:*") {
        subtreeCall++;
        if (subtreeCall === 1) return oldFill.promise;
        return currentFill.promise;
      }
      mainCalls++;
      return Promise.resolve({ cursor: 9, keys: [keyInfo("grp:a")], total_keys: 10_000 });
    });

    const host = mountBrowser();
    await settleThoroughly();
    expandFirstGroupRow(host);
    await vi.waitFor(() => expect(subtreeCalls()).toHaveLength(1));

    const refresh = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.className.includes("h-6 w-6") && !button.hasAttribute("title"));
    expect(refresh, "refresh button").toBeDefined();
    refresh!.click();
    await vi.waitFor(() => expect(mainCalls).toBeGreaterThanOrEqual(2));
    await settleThoroughly();
    expandFirstGroupRow(host);
    expandFirstGroupRow(host);
    await vi.waitFor(() => expect(subtreeCalls()).toHaveLength(2));

    if (outcome === "resolves") oldFill.resolve({ cursor: 88, keys: [keyInfo("grp:stale")], total_keys: 0 });
    else oldFill.reject(new Error("stale subtree failure"));
    await settleThoroughly();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(leafVisible(host, "grp:stale")).toBe(false);

    expandFirstGroupRow(host);
    expandFirstGroupRow(host);
    await settleThoroughly();
    expect(subtreeCalls()).toHaveLength(2);

    currentFill.resolve({ cursor: 0, keys: [keyInfo("grp:current")], total_keys: 0 });
    await settleThoroughly();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
