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
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  redisGetValue: mocks.redisGetValue,
  redisGetTtl: mocks.redisGetTtl,
  redisSetTtl: mocks.redisSetTtl,
  redisSetExpireAt: mocks.redisSetExpireAt,
  redisLoadMore: mocks.redisLoadMore,
}));

vi.mock("@/composables/useEditorFontFamilyStyle", () => ({
  useEditorFontFamilyStyle: () => ({}),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/lib/common/shikiJsonHighlighter", () => ({
  createShikiJsonHighlighter: vi.fn().mockResolvedValue(() => ""),
}));

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

function zsetValue() {
  return {
    key_display: "rank:order",
    key_raw: "rank:order",
    ttl: -1,
    redis_type: "zset",
    data: {
      kind: "zset" as const,
      items: [
        { score: "1", member: blob("2314099896:11842851748888") },
        { score: "2", member: blob("2314101855:22903060973580") },
      ],
      total: 100,
      scan_cursor: 2,
    },
  };
}

function setValue() {
  return {
    key_display: "members",
    key_raw: "members",
    ttl: -1,
    redis_type: "set",
    data: { kind: "set" as const, items: [{ member: blob("alpha") }], total: 1, scan_cursor: undefined },
  };
}

function listValue() {
  return {
    key_display: "queue",
    key_raw: "queue",
    ttl: -1,
    redis_type: "list",
    data: { kind: "list" as const, items: [{ index: 0, value: blob("first") }], total: 1, scan_cursor: undefined },
  };
}

const testI18nMessages = {
  en: {
    redis: {
      searchFields: "Search fields and values",
      searchMembers: "Search members",
      searchItems: "Search items",
      members: "{count} members",
      items: "{count} items",
      loadedMembers: "{loaded} / {total} members loaded",
      loadedItems: "{loaded} / {total} items loaded",
      loadMoreKeys: "Load more",
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

function searchInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("input[placeholder='Search members'], input[placeholder='Search items']");
}

function loadMoreButton(): HTMLButtonElement {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
  return buttons.find((button) => button.textContent?.includes("Load more"))!;
}

async function typeSearch(query: string) {
  const input = searchInput()!;
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  // The Input wrapper syncs its v-model through a passive watcher, so the query only
  // reaches the viewer on the next tick — press Enter after it lands, like real typing.
  await nextTick();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
}

describe("Redis collection member search", () => {
  it("offers a member search box for zset keys", async () => {
    mocks.redisGetValue.mockResolvedValue(zsetValue());
    mountViewer();
    await settle();

    expect(searchInput()).not.toBeNull();
  });

  it("offers a search box for set and list keys", async () => {
    mocks.redisGetValue.mockResolvedValue(setValue());
    mountViewer();
    await settle();
    expect(searchInput()?.placeholder).toBe("Search members");

    for (const { unmount, host } of mountedApps.splice(0)) {
      unmount();
      host.remove();
    }

    mocks.redisGetValue.mockResolvedValue(listValue());
    mountViewer();
    await settle();
    expect(searchInput()?.placeholder).toBe("Search items");
  });

  it("filters zset members server-side and keeps the sort direction", async () => {
    mocks.redisGetValue.mockResolvedValue(zsetValue());
    mocks.redisLoadMore.mockResolvedValue({
      kind: "zset",
      items: [{ score: "2", member: blob("2314101855:22903060973580") }],
      scan_cursor: undefined,
    });
    mountViewer();
    await settle();

    await typeSearch("22903060");

    expect(mocks.redisLoadMore).toHaveBeenCalledWith("connection", 0, "key", "zset", 0, 200, "22903060", "asc");
    expect(document.body.textContent).toContain("2314101855:22903060973580");
    expect(document.body.textContent).not.toContain("2314099896:11842851748888");
  });

  it("carries the active query into load-more paging", async () => {
    mocks.redisGetValue.mockResolvedValue(zsetValue());
    mocks.redisLoadMore.mockResolvedValue({
      kind: "zset",
      items: [{ score: "2", member: blob("2314101855:22903060973580") }],
      scan_cursor: 200,
    });
    mountViewer();
    await settle();
    await typeSearch("22903060");

    mocks.redisLoadMore.mockClear();
    mocks.redisLoadMore.mockResolvedValue({ kind: "zset", items: [], scan_cursor: undefined });
    loadMoreButton().click();
    await settle();

    expect(mocks.redisLoadMore).toHaveBeenCalledWith("connection", 0, "key", "zset", 200, 200, "22903060", "asc");
  });

  it("keeps the query when the zset sort direction is toggled", async () => {
    mocks.redisGetValue.mockResolvedValue(zsetValue());
    mocks.redisLoadMore.mockResolvedValue({
      kind: "zset",
      items: [{ score: "2", member: blob("2314101855:22903060973580") }],
      scan_cursor: undefined,
    });
    mountViewer();
    await settle();
    await typeSearch("22903060");

    mocks.redisLoadMore.mockClear();
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Score"))!.click();
    await settle();

    // Reloading for the new sort order must re-apply the query instead of silently dropping it.
    expect(mocks.redisLoadMore).toHaveBeenCalledWith("connection", 0, "key", "zset", 0, 200, "22903060", "desc");
    expect(searchInput()?.value).toBe("22903060");
  });

  it("drops the total from the count label while a search is active", async () => {
    mocks.redisGetValue.mockResolvedValue(zsetValue());
    mocks.redisLoadMore.mockResolvedValue({
      kind: "zset",
      items: [{ score: "2", member: blob("2314101855:22903060973580") }],
      scan_cursor: undefined,
    });
    mountViewer();
    await settle();
    expect(document.body.textContent).toContain("2 / 100 members loaded");

    await typeSearch("22903060");

    expect(document.body.textContent).toContain("1 members");
    expect(document.body.textContent).not.toContain("/ 100 members loaded");
  });
});
