// @vitest-environment happy-dom

import { createApp, defineComponent, h, KeepAlive, nextTick, ref } from "vue";
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
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redisLoadMore.mockReset();
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
      fields: "{count} fields",
      ttlSecond: "{count}s",
      collectionSearching: "Searching",
      collectionSearchSubmit: "Search",
      collectionSearchSubmitHint: "Click Search or press Enter",
      collectionSearchStop: "Stop search",
      collectionSearchCancel: "Cancel search",
      collectionSearchStopped: "Search stopped; results and progress kept",
      collectionSearchPartial: "Partial results; search not complete",
      collectionSearchComplete: "Search complete",
      collectionSearchEmpty: "No matches found",
      collectionSearchPaused: "Search paused; not complete",
      collectionSearchStalled: "Search did not advance",
      collectionSearchFailed: "Search failed: {error}",
      collectionSearchContinue: "Continue search",
      collectionSearchRetry: "Retry search",
      stopFetchAll: "Stop",
    },
  },
};

function mountViewer(keepAlive = false, keyRaw = ref("key")) {
  const visible = ref(true);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      setup() {
        const viewer = () => (visible.value ? h(RedisValueViewer, { connectionId: "connection", db: 0, keyDisplay: keyRaw.value, keyRaw: keyRaw.value }) : null);
        return () => (keepAlive ? h(KeepAlive, null, { default: viewer }) : viewer());
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: "en", messages: testI18nMessages, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mountedApps.push({ unmount: () => app.unmount(), host });
  return visible;
}

function searchInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("input[placeholder='Search fields and values'], input[placeholder='Search members'], input[placeholder='Search items']");
}

function loadMoreButton(): HTMLButtonElement {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
  return buttons.find((button) => button.textContent?.includes("Load more") || button.textContent?.includes("Continue search"))!;
}

async function typeDraft(query: string) {
  const input = searchInput()!;
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  // Let the Input wrapper's passive v-model watcher settle before submission.
  await nextTick();
}

async function typeSearch(query: string) {
  await typeDraft(query);
  const input = searchInput()!;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
}

describe("Redis collection member search", () => {
  it("waits for the Search button and does not scan while typing", async () => {
    vi.useFakeTimers();
    mocks.redisGetValue.mockResolvedValue(setValue());
    mocks.redisLoadMore.mockResolvedValue({ kind: "set", items: [{ member: blob("needle") }] });
    mountViewer();
    await settle();
    expect(document.querySelector<HTMLButtonElement>("[data-redis-search-submit]")!.disabled).toBe(true);
    await typeDraft("needle");
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.redisLoadMore).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("alpha");
    document.querySelector<HTMLButtonElement>("[data-redis-search-submit]")!.click();
    await settle();
    expect(mocks.redisLoadMore).toHaveBeenCalledWith("connection", 0, "key", "set", 0, 200, "needle", undefined);
    expect(document.body.textContent).toContain("needle");
  });

  it("cancels an in-flight search, restores browsing, and ignores the old response", async () => {
    const browsing = { ...setValue(), data: { kind: "set", items: [{ member: blob("alpha") }], total: 100, scan_cursor: 10 } };
    mocks.redisGetValue.mockResolvedValue(browsing);
    let finish!: (result: unknown) => void;
    mocks.redisLoadMore
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce({ kind: "set", items: [{ member: blob("beta") }] });
    mountViewer();
    await settle();
    await typeSearch("old");
    document.querySelector<HTMLButtonElement>("[data-redis-search-cancel]")!.click();
    await settle();
    expect(searchInput()?.value).toBe("");
    expect(document.body.textContent).toContain("alpha");
    expect(document.querySelector("[data-redis-search-stop]")).toBeNull();
    loadMoreButton().click();
    await settle();
    expect(mocks.redisLoadMore).toHaveBeenCalledTimes(1);
    finish({ kind: "set", items: [{ member: blob("obsolete") }], scan_cursor: 99 });
    for (let i = 0; i < 4; i++) await settle();
    expect(mocks.redisLoadMore.mock.calls[1][4]).toBe(10);
    expect(mocks.redisLoadMore.mock.calls[1][6]).toBeUndefined();
    expect(document.body.textContent).toContain("alpha");
    expect(document.body.textContent).toContain("beta");
    expect(document.body.textContent).not.toContain("obsolete");
  });

  it("discards a submitted search on editing, and Escape cancels the new draft", async () => {
    mocks.redisGetValue.mockResolvedValue(setValue());
    mocks.redisLoadMore.mockResolvedValue({ kind: "set", items: [{ member: blob("found") }] });
    mountViewer();
    await settle();
    await typeSearch("found");
    await typeDraft("new keyword");
    await settle();
    expect(document.body.textContent).toContain("alpha");
    expect(document.body.textContent).not.toContain("found");
    expect(mocks.redisLoadMore).toHaveBeenCalledTimes(1);
    searchInput()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(searchInput()?.value).toBe("");
    expect(document.querySelector("[data-redis-search-cancel]")).toBeNull();
  });

  it("does not submit Enter while an IME composition is active", async () => {
    mocks.redisGetValue.mockResolvedValue(setValue());
    mountViewer();
    await settle();
    await typeDraft("keyword");
    searchInput()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
    await settle();
    expect(mocks.redisLoadMore).not.toHaveBeenCalled();
  });

  it("preserves an unsubmitted draft during a ZSet sort reload", async () => {
    mocks.redisGetValue.mockResolvedValue(zsetValue());
    mocks.redisLoadMore.mockResolvedValue({ kind: "zset", items: zsetValue().data.items, scan_cursor: 2 });
    mountViewer();
    await settle();
    await typeDraft("draft");
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Score"))!.click();
    await settle();
    expect(mocks.redisLoadMore).toHaveBeenCalledTimes(1);
    expect(mocks.redisLoadMore.mock.calls[0][6]).toBeUndefined();
    expect(searchInput()?.value).toBe("draft");
  });

  it.each(["cancel", "edit"])("preserves a queued %s before the ZSet loading view renders", async (intent) => {
    mocks.redisGetValue.mockResolvedValue(zsetValue());
    mocks.redisLoadMore.mockImplementation((_connection, _db, _key, _kind, _cursor, _count, query) => Promise.resolve({ kind: "zset", items: zsetValue().data.items, scan_cursor: query ? undefined : 2 }));
    mountViewer();
    await settle();
    await typeSearch("A");
    mocks.redisLoadMore.mockClear();

    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    mocks.redisGetValue.mockReturnValueOnce(pending);
    const input = searchInput()!;
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Score"))!.click();
    // Both handlers run before Vue replaces the toolbar with the loading view.
    if (intent === "cancel") document.querySelector<HTMLButtonElement>("[data-redis-search-cancel]")!.click();
    else await typeDraft("B");
    await settle();
    // Enter during a reload must obey the same disabled state as the button.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    finish(zsetValue());
    for (let i = 0; i < 4; i++) await settle();

    expect(searchInput()?.value).toBe(intent === "cancel" ? "" : "B");
    expect(mocks.redisLoadMore.mock.calls.every((call) => call[6] == null)).toBe(true);
    expect(mocks.redisLoadMore).not.toHaveBeenCalled();
    mocks.redisLoadMore.mockClear();
    loadMoreButton().click();
    await settle();
    expect(mocks.redisLoadMore).toHaveBeenCalledWith("connection", 0, "key", "zset", 2, 200, undefined, "asc");
  });

  it("updates duplicate Hash values and TTLs without replacing an edit draft or explicit sorting", async () => {
    let finish!: (result: unknown) => void;
    mocks.redisGetValue.mockResolvedValue({ key_display: "hash", key_raw: "hash", ttl: -1, redis_type: "hash", data: { kind: "hash", items: [], total: 25000, scan_cursor: 10 } });
    mocks.redisLoadMore.mockResolvedValueOnce({ kind: "hash", items: [{ field: blob("b-field"), value: blob("old"), field_ttl: 100 }], scan_cursor: 10 }).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mountViewer();
    await settle();
    document.querySelector<HTMLButtonElement>("[role='columnheader'] button")!.click();
    await settle();
    await typeSearch("field");
    document.querySelector<HTMLElement>("[data-redis-value-row]")!.click();
    await settle();
    document.querySelector<HTMLElement>("[data-redis-member-utf8-viewer]")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await settle();
    const editor = document.querySelector<HTMLTextAreaElement>("[data-redis-member-utf8-editor]")!;
    editor.value = "retained draft";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    finish({
      kind: "hash",
      items: [
        { field: blob("b-field"), value: blob("new"), field_ttl: 50 },
        { field: blob("a-field"), value: blob("other"), field_ttl: 80 },
      ],
    });
    await settle();
    expect(editor.value).toBe("retained draft");
    expect(document.querySelector("[role='columnheader']")?.getAttribute("aria-sort")).toBe("ascending");
    const rows = [...document.querySelectorAll<HTMLElement>("[data-redis-value-row]")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("a-field");
    expect(rows[1].textContent).toContain("new");
    expect(rows[1].textContent).toContain("50s");
  });
  it("retries an initial load that settled while the viewer was inactive", async () => {
    let finish!: (value: unknown) => void;
    mocks.redisGetValue
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce(setValue());
    const visible = mountViewer(true);
    await settle();
    visible.value = false;
    await settle();
    finish(setValue());
    await settle();
    visible.value = true;
    await settle();
    expect(mocks.redisGetValue).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("alpha");
    expect(searchInput()).not.toBeNull();
  });
  it("does not let a stale search overwrite a refreshed collection", async () => {
    mocks.redisGetValue.mockResolvedValueOnce(setValue()).mockResolvedValueOnce({ ...setValue(), data: { kind: "set", items: [{ member: blob("fresh") }], total: 1 } });
    let finish!: (page: unknown) => void;
    mocks.redisLoadMore.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mountViewer();
    await settle();
    await typeSearch("old");
    document.querySelector<HTMLButtonElement>("[data-redis-value-refresh]")!.click();
    await settle();
    finish({ kind: "set", items: [{ member: blob("obsolete-result") }], scan_cursor: 10 });
    await settle();
    expect(document.body.textContent).toContain("fresh");
    expect(document.body.textContent).not.toContain("obsolete-result");
    expect(searchInput()?.value).toBe("");
  });
  it("uses the new key after scope invalidation while the old request is still in flight", async () => {
    mocks.redisGetValue.mockResolvedValue(setValue());
    let finish!: (page: unknown) => void;
    mocks.redisLoadMore
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce({ kind: "set", items: [{ member: blob("new-result") }] });
    const key = ref("key");
    mountViewer(false, key);
    await settle();
    await typeSearch("old");
    key.value = "new-key";
    await settle();
    await typeSearch("new");
    expect(mocks.redisLoadMore).toHaveBeenCalledTimes(1);
    finish({ kind: "set", items: [{ member: blob("obsolete-result") }] });
    for (let i = 0; i < 4; i++) await settle();
    expect(mocks.redisLoadMore.mock.calls[1][2]).toBe("new-key");
    expect(document.body.textContent).toContain("new-result");
    expect(document.body.textContent).not.toContain("obsolete-result");
  });
  it("allows ordinary paging to resume after deactivation without consuming it twice", async () => {
    mocks.redisGetValue.mockResolvedValue({ ...setValue(), data: { ...setValue().data, total: 100, scan_cursor: 10 } });
    let finish!: (page: unknown) => void;
    mocks.redisLoadMore.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const visible = mountViewer(true);
    await settle();
    loadMoreButton().click();
    await settle();
    visible.value = false;
    await settle();
    finish({ kind: "set", items: [{ member: blob("resumed") }], scan_cursor: undefined });
    await settle();
    visible.value = true;
    await settle();
    loadMoreButton().click();
    await settle();
    expect(mocks.redisLoadMore).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("resumed");
  });
  it("rolls back a descending reload canceled by deactivation and keeps ascending pagination", async () => {
    mocks.redisGetValue.mockResolvedValue(zsetValue());
    const visible = mountViewer(true);
    await settle();
    let finish!: (value: unknown) => void;
    mocks.redisGetValue.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Score"))!.click();
    await settle();
    visible.value = false;
    await settle();
    finish(zsetValue());
    await settle();
    visible.value = true;
    await settle();
    mocks.redisLoadMore.mockResolvedValue({ kind: "zset", items: [], scan_cursor: undefined });
    loadMoreButton().click();
    await settle();
    expect(mocks.redisLoadMore).toHaveBeenCalledWith("connection", 0, "key", "zset", 2, 200, undefined, "asc");
  });
  it("automatically reaches a hash field after consecutive empty scan slices", async () => {
    mocks.redisGetValue.mockResolvedValue({ key_display: "hash", key_raw: "hash", ttl: -1, redis_type: "hash", data: { kind: "hash", items: [], total: 25271, scan_cursor: 10 } });
    mocks.redisLoadMore
      .mockResolvedValueOnce({ kind: "hash", items: [], scan_cursor: 20 })
      .mockResolvedValueOnce({ kind: "hash", items: [], scan_cursor: 30 })
      .mockResolvedValueOnce({ kind: "hash", items: [{ field: blob("EC00100051EB02DD"), value: blob("exists") }], scan_cursor: 40 })
      .mockResolvedValueOnce({ kind: "hash", items: [] });
    mountViewer();
    await settle();
    await typeSearch("EC00100051EB02DD");
    for (let i = 0; i < 4; i++) await settle();
    expect(mocks.redisLoadMore.mock.calls.map((call) => call[4])).toEqual([0, 20, 30, 40]);
    expect(document.body.textContent).toContain("1 fields");
    expect(document.body.textContent).toContain("Search complete");
  });

  it("does not enqueue intermediate keywords behind a delayed search", async () => {
    let finish!: (result: unknown) => void;
    mocks.redisGetValue.mockResolvedValue(setValue());
    mocks.redisLoadMore
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce({ kind: "set", items: [{ member: blob("C") }], scan_cursor: undefined });
    mountViewer();
    await settle();
    await typeSearch("A");
    await typeSearch("B");
    await typeSearch("C");
    expect(mocks.redisLoadMore).toHaveBeenCalledTimes(1);
    finish({ kind: "set", items: [{ member: blob("A") }], scan_cursor: 10 });
    for (let i = 0; i < 4; i++) await settle();
    expect(mocks.redisLoadMore.mock.calls.map((call) => call[6])).toEqual(["A", "C"]);
    expect(document.body.textContent).toContain("C");
    expect(document.body.textContent).toContain("Search complete");
  });

  it("shows stopping as incomplete, and can continue from an unstarted first cursor", async () => {
    let finish!: (result: unknown) => void;
    mocks.redisGetValue.mockResolvedValue(setValue());
    mocks.redisLoadMore
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce({ kind: "set", items: [], scan_cursor: undefined });
    mountViewer();
    await settle();
    await typeSearch("missing");
    document.querySelector<HTMLButtonElement>("[data-redis-search-stop]")!.click();
    await settle();
    expect(document.body.textContent).toContain("Search stopped; results and progress kept");
    expect(document.body.textContent).not.toContain("No matches found");
    document.querySelector<HTMLButtonElement>("[data-redis-search-continue]")!.click();
    await settle();
    expect(mocks.redisLoadMore).toHaveBeenCalledTimes(1);
    finish({ kind: "set", items: [], scan_cursor: 50 });
    for (let i = 0; i < 4; i++) await settle();
    expect(mocks.redisLoadMore.mock.calls[1][4]).toBe(50);
    expect(document.body.textContent).toContain("No matches found");
  });
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

  it("carries the active query into automatic continuation", async () => {
    mocks.redisGetValue.mockResolvedValue(zsetValue());
    mocks.redisLoadMore
      .mockResolvedValueOnce({
        kind: "zset",
        items: [{ score: "2", member: blob("2314101855:22903060973580") }],
        scan_cursor: 200,
      })
      .mockResolvedValueOnce({ kind: "zset", items: [], scan_cursor: undefined });
    mountViewer();
    await settle();
    await typeSearch("22903060");

    for (let i = 0; i < 4; i++) await settle();

    expect(mocks.redisLoadMore).toHaveBeenCalledWith("connection", 0, "key", "zset", 200, 200, "22903060", "asc");
    expect(document.body.textContent).toContain("Search complete");
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
