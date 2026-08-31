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
        // Real RecycleScroller only mounts as many rows as fit the viewport;
        // rendering everything here would defeat the point of this test, so
        // cap it the same way the expiry spec's mock does.
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

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function resetApiMocks() {
  vi.clearAllMocks();
  mocks.redisScanPageSize = 100;
  mocks.infiniteScroll = true;
  mocks.queryResultMaxRowsEnabled = true;
  mocks.queryResultMaxRows = 5000;
  mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [], total_keys: 0 });
}

// A short, un-collapsed tree (a real DB has millions of keys folded into a
// handful of visible top-level groups) never overflows the scroller's
// viewport, so it never emits a native `scroll` event. Simulate that real
// layout fact — happy-dom always reports 0 for clientHeight/scrollHeight —
// by stubbing both getters for the specific scroller element under test.
let originalClientHeight: PropertyDescriptor | undefined;
let originalScrollHeight: PropertyDescriptor | undefined;

function stubNonOverflowingViewport() {
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
      return this.classList.contains("redis-key-scroller") ? 90 : 0;
    },
  });
}

function restoreViewportStub() {
  if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
}

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

describe("RedisKeyBrowser infinite scroll auto-continue (issue #6022)", () => {
  it("keeps fetching pages on its own when the loaded rows don't overflow the viewport, without any scroll event", async () => {
    stubNonOverflowingViewport();

    const firstPage: RedisKeyInfo[] = [{ key_display: "id:acct:1:mt5:live01:59995072:x", key_raw: "a", key_type: "string", ttl: -1, size: 0, value_preview: "" }];
    const secondPage: RedisKeyInfo[] = [{ key_display: "id:acct:1:mt5:live01:59995129:x", key_raw: "b", key_type: "string", ttl: -1, size: 0, value_preview: "" }];
    const thirdPage: RedisKeyInfo[] = [
      { key_display: "id:acct:1:mt5:live01:59995904:x", key_raw: "c", key_type: "string", ttl: -1, size: 0, value_preview: "" },
      { key_display: "id:acct:1:mt4:live04:40001:y", key_raw: "d", key_type: "string", ttl: -1, size: 0, value_preview: "" },
    ];
    // A large real keyspace: cursor keeps moving and only closes on the
    // third round-trip, same shape as scanning a few hundred-thousand keys.
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number) => {
      if (cursor === 0) return Promise.resolve({ cursor: 7, keys: firstPage, total_keys: 200_004 });
      if (cursor === 7) return Promise.resolve({ cursor: 91, keys: secondPage, total_keys: 0 });
      return Promise.resolve({ cursor: 0, keys: thirdPage, total_keys: 0 });
    });

    const host = mountBrowser();
    await settle();
    await settle();
    await settle();

    // Nobody dispatched a `scroll` event — a container shorter than its
    // viewport never fires one in a real browser — yet all three pages must
    // have been pulled automatically. All 4 keys share the "id" top-level
    // segment, so the (collapsed-by-default) root group's own badge is
    // enough to prove every page made it into the tree, without needing to
    // expand each nested folder just to read the leaf labels.
    expect(mocks.redisScanKeysBatch).toHaveBeenCalledTimes(3);
    expect(host.textContent).toContain("id");
    expect(host.textContent).toContain("(4)");
  });

  it("stops auto-fetching once the loaded rows actually overflow the viewport", async () => {
    stubNonOverflowingViewport();
    // This time the scroller reports real overflow after the first page, so
    // the existing scroll-driven `loadMore` is expected to take over instead.
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("redis-key-scroller") ? 5000 : 0;
      },
    });

    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number) => {
      if (cursor === 0) return Promise.resolve({ cursor: 7, keys: [{ key_display: "k1", key_raw: "a", key_type: "string", ttl: -1, size: 0, value_preview: "" }], total_keys: 200_004 });
      return Promise.resolve({ cursor: 0, keys: [{ key_display: "k2", key_raw: "b", key_type: "string", ttl: -1, size: 0, value_preview: "" }], total_keys: 0 });
    });

    mountBrowser();
    await settle();
    await settle();

    expect(mocks.redisScanKeysBatch).toHaveBeenCalledTimes(1);
  });

  it("rechecks bounded auto-loading when the viewport grows", async () => {
    stubNonOverflowingViewport();
    let overflow = true;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("redis-key-scroller") ? (overflow ? 5000 : 90) : 0;
      },
    });
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number) => {
      if (cursor === 0) return Promise.resolve({ cursor: 7, keys: [keyInfo("a")], total_keys: 200_004 });
      return Promise.resolve({ cursor: 0, keys: [keyInfo("b")], total_keys: 0 });
    });

    const host = mountBrowser();
    await settleThoroughly();
    expect(mocks.redisScanKeysBatch).toHaveBeenCalledTimes(1);

    overflow = false;
    host.querySelector(".redis-key-scroller")?.dispatchEvent(new Event("resize"));
    await settleThoroughly();

    expect(mocks.redisScanKeysBatch).toHaveBeenCalledTimes(2);
  });
});

// Use the real production default page size (not an artificial single-call
// size) so these tests actually exercise the amplification the review
// flagged: with the default 1,000-row page, a single logical "page" can
// still internally retry across many backend calls while it comes back
// empty (COUNT is only a hint), so a page-count cap alone doesn't bound the
// real work. See `AUTO_LOAD_TOTAL_SCAN_ITERATIONS` in RedisKeyBrowser.vue —
// the whole automatic-fill operation shares ONE SCAN-iteration budget across
// every backend call it makes, however many logical pages that spans.
const PRODUCTION_PAGE_SIZE = 1000;
// Mirrors the constants in RedisKeyBrowser.vue: `iterations` per backend
// call is capped at 8, and the automatic-fill operation gets a total budget
// of 50 SCAN iterations. Supported page sizes split that budget differently:
// 200/1,000-row pages need at most 7 backend calls, while 5,000/10,000-row
// pages can need at most 10. The shared iteration limit remains the invariant.
const ITERATIONS_PER_CALL = 8;
const AUTO_LOAD_TOTAL_SCAN_ITERATIONS = 50;
const AUTO_LOAD_MAX_CALLS = Math.ceil(AUTO_LOAD_TOTAL_SCAN_ITERATIONS / ITERATIONS_PER_CALL);
const AUTO_LOAD_PAGE_SIZE_CASES = [
  { pageSize: 200, maxCalls: 7 },
  { pageSize: 1000, maxCalls: 7 },
  { pageSize: 5000, maxCalls: 10 },
  { pageSize: 10000, maxCalls: 10 },
] as const;

async function settleThoroughly(rounds = 40) {
  for (let i = 0; i < rounds; i++) await settle();
}

function keyInfo(rawKey: string): RedisKeyInfo {
  return { key_display: rawKey, key_raw: rawKey, key_type: "string", ttl: -1, size: 0, value_preview: "" };
}

// `iterations` (aka `max_iterations`) is the 6th positional arg the frontend
// sends to `redisScanKeysBatch` — the same unit the backend spends as real
// Redis SCAN calls (see `crates/dbx-core/src/db/redis_driver.rs`).
function totalIterationsRequested(): number {
  return mocks.redisScanKeysBatch.mock.calls.reduce((sum: number, call: unknown[]) => sum + (call[5] as number), 0);
}

describe("RedisKeyBrowser automatic continuation request budget (PR #6313 review)", () => {
  beforeEach(() => {
    mocks.redisScanPageSize = PRODUCTION_PAGE_SIZE;
  });

  it.each(AUTO_LOAD_PAGE_SIZE_CASES)("stops after at most $maxCalls automatic backend calls for page size $pageSize", async ({ pageSize, maxCalls }) => {
    stubNonOverflowingViewport();
    mocks.redisScanPageSize = pageSize;
    let call = 0;
    // The tree-vs-empty-state view only mounts the scroller once at least one
    // key has loaded, so seed exactly one key on the first page — every page
    // after that comes back empty with a cursor that always advances and
    // never hits 0. An unbounded loop would spin until the (huge) keyspace is
    // exhausted or the process runs out of time.
    mocks.redisScanKeysBatch.mockImplementation((_c: string, _d: number, cursor: number) => {
      call++;
      return Promise.resolve({ cursor: cursor + 1, keys: call === 1 ? [keyInfo("seed")] : [], total_keys: 5_000_000 });
    });

    mountBrowser();
    await settleThoroughly();

    // 1 initial page + the automatic-fill operation's total iteration budget,
    // never the ~147-call amplification a page-count-only cap would allow at
    // this page size.
    expect(mocks.redisScanKeysBatch).toHaveBeenCalledTimes(1 + maxCalls);
    expect(totalIterationsRequested()).toBeLessThanOrEqual(ITERATIONS_PER_CALL + AUTO_LOAD_TOTAL_SCAN_ITERATIONS);
    const callsAtBound = mocks.redisScanKeysBatch.mock.calls.length;
    await settleThoroughly(10);
    expect(mocks.redisScanKeysBatch).toHaveBeenCalledTimes(callsAtBound);
  });

  it("stops after a bounded total of backend calls when every page comes back with only already-loaded keys, at the production page size", async () => {
    stubNonOverflowingViewport();
    // Every page repeats the same key, so unique loaded/visible keys stay at 1
    // forever — a stop condition based on unique-key growth alone never fires.
    mocks.redisScanKeysBatch.mockImplementation((_c: string, _d: number, cursor: number) => Promise.resolve({ cursor: cursor + 1, keys: [keyInfo("dup")], total_keys: 5_000_000 }));

    mountBrowser();
    await settleThoroughly();

    expect(mocks.redisScanKeysBatch).toHaveBeenCalledTimes(1 + AUTO_LOAD_MAX_CALLS);
    expect(totalIterationsRequested()).toBeLessThanOrEqual(ITERATIONS_PER_CALL + AUTO_LOAD_TOTAL_SCAN_ITERATIONS);
  });

  it("stops after a bounded total of backend calls against a sparse filter that only rarely yields a new key, at the production page size", async () => {
    stubNonOverflowingViewport();
    let call = 0;
    mocks.redisScanKeysBatch.mockImplementation((_c: string, _d: number, cursor: number) => {
      call++;
      // A new unique key surfaces on the first page (so the scroller mounts)
      // and then only every 3rd call after that — same shape as a narrow
      // pattern against a huge, mostly-non-matching keyspace.
      const keys = call === 1 || call % 3 === 0 ? [keyInfo(`sparse-${call}`)] : [];
      return Promise.resolve({ cursor: cursor + 1, keys, total_keys: 5_000_000 });
    });

    mountBrowser();
    await settleThoroughly();

    expect(mocks.redisScanKeysBatch).toHaveBeenCalledTimes(1 + AUTO_LOAD_MAX_CALLS);
    expect(totalIterationsRequested()).toBeLessThanOrEqual(ITERATIONS_PER_CALL + AUTO_LOAD_TOTAL_SCAN_ITERATIONS);
  });

  it("still stops on reaching the configured max-key limit, well under the iteration budget", async () => {
    stubNonOverflowingViewport();
    mocks.queryResultMaxRows = 3;
    let call = 0;
    mocks.redisScanKeysBatch.mockImplementation((_c: string, _d: number, cursor: number) => {
      call++;
      return Promise.resolve({ cursor: cursor + 1, keys: [keyInfo(`k${call}`)], total_keys: 5_000_000 });
    });

    mountBrowser();
    await settleThoroughly();

    // 1 initial page + 2 automatic pages reaches the 3-key limit, well before
    // the total iteration budget would otherwise cut it off.
    expect(mocks.redisScanKeysBatch).toHaveBeenCalledTimes(3);
  });
});

describe("RedisKeyBrowser loadMore failure handling (PR #6313 review)", () => {
  it("does not automatically retry after a page request fails", async () => {
    stubNonOverflowingViewport();
    mocks.redisScanKeysBatch.mockResolvedValueOnce({ cursor: 7, keys: [keyInfo("a")], total_keys: 200_004 }).mockRejectedValue(new Error("backend unavailable"));

    mountBrowser();
    await settleThoroughly();

    // One successful initial page, one failed automatic follow-up — and then
    // nothing further, even after settling repeatedly.
    expect(mocks.redisScanKeysBatch).toHaveBeenCalledTimes(2);
    expect(mocks.toast).toHaveBeenCalledTimes(1);

    await settleThoroughly(10);
    expect(mocks.redisScanKeysBatch).toHaveBeenCalledTimes(2);
  });

  it("charges a failed automatic request to the shared iteration budget", async () => {
    stubNonOverflowingViewport();
    mocks.redisScanKeysBatch
      .mockResolvedValueOnce({ cursor: 7, keys: [keyInfo("a")], total_keys: 200_004 })
      .mockRejectedValueOnce(new Error("backend unavailable"))
      .mockImplementation((_connectionId: string, _db: number, cursor: number) => Promise.resolve({ cursor: cursor + 1, keys: [], total_keys: 0 }));

    const host = mountBrowser();
    await settleThoroughly();
    expect(mocks.redisScanKeysBatch).toHaveBeenCalledTimes(2);

    host.querySelector(".redis-key-scroller")?.dispatchEvent(new Event("resize"));
    await settleThoroughly();

    expect(totalIterationsRequested()).toBeLessThanOrEqual(ITERATIONS_PER_CALL + AUTO_LOAD_TOTAL_SCAN_ITERATIONS);
    expect(mocks.redisScanKeysBatch.mock.calls.length).toBeLessThanOrEqual(1 + AUTO_LOAD_MAX_CALLS);
  });
});

// A group's `loadedLeafCount` only reflects keys the SCAN happened to return
// before auto-load stopped (see `redisKeyTree.ts`); when the cursor hasn't
// reached 0 yet, that count is not the folder's real total. Issue #6392: a
// user compared DBX's tree against `redis-cli --scan` and saw folder counts
// far below the real per-prefix cardinality, with nothing in the UI hinting
// the numbers were partial.
describe("RedisKeyBrowser group key counts reflect incomplete loading (issue #6392)", () => {
  it("marks a group's count as partial while more keys remain unscanned", async () => {
    stubNonOverflowingViewport();
    // cursor never returns to 0, so hasMore stays true even after the
    // shared auto-load budget is exhausted.
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number) => {
      if (cursor === 0) return Promise.resolve({ cursor: 1, keys: [keyInfo("grp:a"), keyInfo("grp:b")], total_keys: 500 });
      return Promise.resolve({ cursor: cursor + 1, keys: [], total_keys: 0 });
    });

    const host = mountBrowser();
    await settleThoroughly();

    const countBadge = host.querySelector(".text-muted-foreground.ml-1");
    expect(countBadge?.textContent).toBe("(2+)");
    expect(countBadge?.getAttribute("title")).toBeTruthy();
  });

  it("shows an exact count once every key has actually been scanned", async () => {
    stubNonOverflowingViewport();
    mocks.redisScanKeysBatch.mockResolvedValue({ cursor: 0, keys: [keyInfo("grp:a"), keyInfo("grp:b")], total_keys: 2 });

    const host = mountBrowser();
    await settleThoroughly();

    const countBadge = host.querySelector(".text-muted-foreground.ml-1");
    expect(countBadge?.textContent).toBe("(2)");
    expect(countBadge?.getAttribute("title")).toBeFalsy();
  });
});

describe("RedisKeyBrowser group subtree fill on expand (issue #7162)", () => {
  beforeEach(() => {
    mocks.redisScanPageSize = 100;
  });

  function scanCallsWithPattern(pattern: string): number {
    return mocks.redisScanKeysBatch.mock.calls.filter((call: unknown[]) => call[3] === pattern).length;
  }

  // Clicks the group row itself. `[data-redis-group]` marks the group's
  // selection checkbox: it carries `cursor-pointer` itself and consumes the
  // click, so a `closest()` from it can never reach the expanding row — walk
  // up to the checkbox's row container (the div with the row click handler)
  // instead.
  function expandFirstGroupRow(host: HTMLElement) {
    const checkbox = host.querySelector<HTMLElement>("[data-redis-group]");
    const row = checkbox?.parentElement?.parentElement;
    expect(row?.className).toContain("cursor-pointer");
    row!.click();
  }

  // Overflowing viewport: rows render (RecycleScroller buffer 600) while the
  // bounded auto-fill stays off, reproducing the stranded state from the
  // issue — the main scan is still open (hasMore), so the tree is silently
  // partial and a key that search finds may not exist in the tree at all.
  function stubOverflowingViewport() {
    stubNonOverflowingViewport();
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("redis-key-scroller") ? 5000 : 100;
      },
    });
  }

  it("fills the expanded group's subtree via a dedicated prefix scan without advancing the main scan", async () => {
    stubOverflowingViewport();
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number, pattern: string) => {
      if (pattern === "grp:*") {
        return Promise.resolve({ cursor: 0, keys: [keyInfo("grp:hidden"), keyInfo("grp:sub:x")], total_keys: 0 });
      }
      if (cursor === 0) return Promise.resolve({ cursor: 9, keys: [keyInfo("grp:a")], total_keys: 10_000 });
      return Promise.resolve({ cursor: 9, keys: [], total_keys: 0 });
    });

    const host = mountBrowser();
    await settleThoroughly();

    // Only the first browse page ran: the tree holds `grp:a` alone and the
    // main scan is still open.
    expect(scanCallsWithPattern("*")).toBe(1);
    expect(scanCallsWithPattern("grp:*")).toBe(0);
    expect(host.textContent).toContain("grp");

    expandFirstGroupRow(host);
    await settleThoroughly();

    // Expanding the group scanned its subtree with a fresh cursor; the main
    // browse cursor was not advanced (no extra `*` pages).
    expect(scanCallsWithPattern("grp:*")).toBe(1);
    expect(scanCallsWithPattern("*")).toBe(1);
    expect(host.textContent).toContain("hidden");
    expect(host.textContent).toContain("sub");

    // Re-collapse + re-expand must not rescan the already-completed subtree.
    expandFirstGroupRow(host);
    await settleThoroughly();
    expandFirstGroupRow(host);
    await settleThoroughly();
    expect(scanCallsWithPattern("grp:*")).toBe(1);
  });

  it("skips the subtree scan when the main scan already completed", async () => {
    stubOverflowingViewport();
    mocks.redisScanKeysBatch.mockImplementation((_connectionId: string, _db: number, cursor: number, pattern: string) => {
      expect(pattern).toBe("*");
      if (cursor === 0) return Promise.resolve({ cursor: 0, keys: [keyInfo("grp:a"), keyInfo("grp:b")], total_keys: 2 });
      return Promise.resolve({ cursor: 0, keys: [], total_keys: 0 });
    });

    const host = mountBrowser();
    await settleThoroughly();

    expandFirstGroupRow(host);
    await settleThoroughly();

    expect(scanCallsWithPattern("grp:*")).toBe(0);
    expect(host.textContent).toContain("b");
  });
});
