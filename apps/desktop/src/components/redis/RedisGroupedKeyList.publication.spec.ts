// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, shallowRef } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import type { RedisKeyInfo } from "@/lib/backend/api";
import { defaultRedisKeyGrouping } from "@/lib/redis/redisKeyGrouping";
import RedisGroupedKeyList from "./RedisGroupedKeyList.vue";

// Deliberately use the installed RecycleScroller, not a mock that rerenders
// whenever updateVisibleItems is called. Same-ID headers must really rebind.
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, values?: { count: number }) => (values ? `${key}:${values.count}` : key) }) }));

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mountGroups(customConfig = { ...defaultRedisKeyGrouping(), enabled: true }) {
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
  const keys = shallowRef<RedisKeyInfo[]>([]);
  const scope = shallowRef("c:0");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const config = shallowRef(customConfig);
  const checked = new Set<string>();
  const selected = shallowRef<string | null>(null);
  const onSelect = vi.fn();
  const onCheck = vi.fn();
  const list = shallowRef<InstanceType<typeof RedisGroupedKeyList> | null>(null);
  const app = createApp(
    defineComponent({
      setup: () => () => h(RedisGroupedKeyList, { ref: list, keys: keys.value, config: config.value, scope: scope.value, structureRevision: 0, separator: ":", selected: selected.value, checked, busy: false, metadataEpoch: 0, treeAllowed: true, onSelect, onCheck }),
    }),
  );
  app.mount(host);
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    app.unmount();
    host.remove();
  };
  cleanups.push(unmount);
  return { host, keys, scope, config, checked, selected, onSelect, onCheck, list, unmount, height };
}

function key(n: number): RedisKeyInfo {
  return { key_raw: btoa(`key:${n}`), key_display: `key:${n}`, ttl: -1, key_type: "string" };
}

async function flushPublication() {
  if (!vi.isFakeTimers()) await new Promise((resolve) => setTimeout(resolve, 20));
  for (let i = 0; i < 12; i++) await nextTick();
}

it("automatically rebinds same-ID group counts through the real scroller", async () => {
  const { host, keys } = mountGroups();
  keys.value = [key(0)];
  await flushPublication();
  expect(host.textContent).toContain("redisGrouping.count:1");
  const header = host.querySelector('[role="button"]');
  keys.value = [...keys.value, key(1), key(2)];
  await flushPublication();
  expect(host.textContent).toContain("redisGrouping.count:3");
  expect(host.textContent).not.toContain("redisGrouping.preparing");
  expect(host.querySelector('[role="button"]')).toBe(header);
});

it("finishes without interaction when timers are delayed instead of paying a timer per checkpoint", async () => {
  vi.useFakeTimers();
  let workTime = 0;
  vi.spyOn(performance, "now").mockImplementation(() => workTime++);
  const timer = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => timer(callback, Math.max(1000, delay ?? 0), ...args)) as typeof setTimeout);
  const { host, keys } = mountGroups();
  keys.value = [key(0)];
  await flushPublication();
  expect(host.textContent).toContain("redisGrouping.count:1");
  keys.value = Array.from({ length: 10_000 }, (_, n) => key(n));
  await flushPublication();
  expect(host.textContent).toContain("redisGrouping.preparing");
  // 20 chunks, but only two exhausted 8ms work budgets.
  await vi.advanceTimersByTimeAsync(3000);
  await flushPublication();
  expect(host.textContent).toContain("redisGrouping.count:10000");
  expect(host.textContent).not.toContain("redisGrouping.preparing");
});

it("does not publish a delayed build after changing database scope", async () => {
  vi.useFakeTimers();
  let workTime = 0;
  vi.spyOn(performance, "now").mockImplementation(() => workTime++);
  const { host, keys, scope } = mountGroups();
  keys.value = Array.from({ length: 10_000 }, (_, n) => key(n));
  await flushPublication();
  expect(host.textContent).toContain("redisGrouping.preparing");
  scope.value = "c:1";
  keys.value = [key(20_000), key(20_001)];
  await flushPublication();
  await vi.advanceTimersByTimeAsync(1000);
  await flushPublication();
  expect(host.textContent).toContain("redisGrouping.count:2");
  expect(host.textContent).not.toContain("redisGrouping.count:10000");
  expect(host.textContent).not.toContain("redisGrouping.preparing");
});

it("cancels a delayed build on unmount without trying to refresh its scroller", async () => {
  vi.useFakeTimers();
  let workTime = 0;
  vi.spyOn(performance, "now").mockImplementation(() => workTime++);
  const { host, keys, unmount } = mountGroups();
  keys.value = Array.from({ length: 10_000 }, (_, n) => key(n));
  await flushPublication();
  expect(host.textContent).toContain("redisGrouping.preparing");
  unmount();
  await vi.advanceTimersByTimeAsync(1000);
  expect(vi.getTimerCount()).toBe(0);
  expect(host.childNodes).toHaveLength(0);
});

it.each(["list", "tree"] as const)("pins the allowed ancestors in %s and collapses to a reachable header without changing selection", async (inner_view) => {
  const state = mountGroups({ ...defaultRedisKeyGrouping(), enabled: true, inner_view });
  state.keys.value = Array.from({ length: 200 }, (_, n) => key(n));
  await flushPublication();
  const outer = () => state.host.querySelector<HTMLElement>('[data-redis-group-header="custom:unmatched"]')!;
  expect(state.host.querySelector("[data-redis-sticky-group]")).toBeNull();
  expect(outer()).not.toBeNull();
  outer().click();
  await flushPublication();
  if (inner_view === "tree") {
    state.host.querySelector<HTMLElement>('[data-redis-group-header*="namespace"]')!.click();
    await flushPublication();
  }
  state.checked.add(key(20).key_raw);
  state.selected.value = key(20).key_raw;
  await nextTick();
  const element = state.host.querySelector<HTMLElement>(".redis-key-scroller")!;
  element.scrollTop = 1500;
  element.dispatchEvent(new Event("scroll"));
  await nextTick();
  const pinned = state.host.querySelector<HTMLElement>("[data-redis-sticky-group]")!;
  expect(pinned.dataset.redisStickyGroup).toBe("custom:unmatched");
  expect(pinned.textContent).toContain("redisGrouping.count:200");
  expect((inner_view === "tree" ? pinned.querySelector("[data-redis-sticky-toggle]")! : pinned).getAttribute("aria-expanded")).toBe("true");
  expect(state.host.querySelectorAll("[data-redis-sticky-group]")).toHaveLength(inner_view === "tree" ? 2 : 1);
  // The outgoing legacy-view anchor must identify a visible descendant, not
  // the row hidden beneath the pinned header. Tree adds its namespace row.
  expect(state.list.value!.getViewportAnchor()).toEqual({ rowIndex: inner_view === "tree" ? 52 : 51, keyRaw: key(50).key_raw });
  if (inner_view === "tree") pinned.querySelector<HTMLButtonElement>("[data-redis-sticky-toggle]")!.click();
  else pinned.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flushPublication();
  expect(element.scrollTop).toBe(0);
  expect(outer().getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(outer());
  expect(state.host.querySelector("[data-redis-sticky-group]")).toBeNull();
  expect(state.checked.has(key(20).key_raw)).toBe(true);
  expect(state.selected.value).toBe(key(20).key_raw);
  expect(state.onSelect).not.toHaveBeenCalled();
  expect(state.onCheck).not.toHaveBeenCalled();
});

it("pushes off at the next group, switches its identity and clears stale headers on scope replacement", async () => {
  const state = mountGroups({ ...defaultRedisKeyGrouping(), enabled: true, rules: [{ id: "first", name: "First", enabled: true, includes: ["key:?"], excludes: [] }] });
  state.keys.value = Array.from({ length: 200 }, (_, n) => key(n));
  await flushPublication();
  Array.from(state.host.querySelectorAll<HTMLElement>("[data-redis-group-header]"))
    .find((node) => node.dataset.redisGroupHeader === 'custom:"first"')!
    .click();
  await flushPublication();
  state.host.querySelector<HTMLElement>('[data-redis-group-header="custom:unmatched"]')!.click();
  await flushPublication();
  const element = state.host.querySelector<HTMLElement>(".redis-key-scroller")!;
  // First has 10 keys + its header; next boundary is at 11 * 30.
  element.scrollTop = 11 * 30 - 15;
  element.dispatchEvent(new Event("scroll"));
  await nextTick();
  let pinned = state.host.querySelector<HTMLElement>("[data-redis-sticky-group]")!;
  expect(pinned).not.toBeNull();
  expect(pinned.dataset.redisStickyGroup).toBe('custom:"first"');
  expect(pinned.parentElement!.style.transform).toBe("translateY(-15px)");
  // During push-off only 15px is covered; the next natural header is visible.
  expect(state.list.value!.getViewportAnchor()).toEqual({ rowIndex: 11, keyRaw: undefined });
  element.scrollTop = 12 * 30;
  element.dispatchEvent(new Event("scroll"));
  await nextTick();
  pinned = state.host.querySelector<HTMLElement>("[data-redis-sticky-group]")!;
  expect(pinned.dataset.redisStickyGroup).toBe("custom:unmatched");
  state.scope.value = "c:1";
  state.keys.value = [];
  await flushPublication();
  expect(state.host.querySelector("[data-redis-sticky-group]")).toBeNull();
});

it("compresses deep ancestors, navigates without collapsing and restores an inner collapse through the installed scroller", async () => {
  const state = mountGroups({ ...defaultRedisKeyGrouping(), enabled: true, inner_view: "tree" });
  const names = Array.from({ length: 200 }, (_, n) => `a:b:c:d:${n}`);
  state.keys.value = names.map((name) => ({ key_display: name, key_raw: btoa(name), ttl: -1, key_type: "string" }));
  await flushPublication();
  const natural = (id: string) => Array.from(state.host.querySelectorAll<HTMLElement>("[data-redis-group-header]")).find((node) => node.dataset.redisGroupHeader === id)!;
  const namespace = (parts: string[]) => `custom:unmatched:namespace:${JSON.stringify(parts)}`;
  for (const id of ["custom:unmatched", namespace(["a"]), namespace(["a", "b"]), namespace(["a", "b", "c"]), namespace(["a", "b", "c", "d"])]) {
    natural(id).click();
    await flushPublication();
  }
  const element = state.host.querySelector<HTMLElement>(".redis-key-scroller")!;
  const scroll = async (top: number) => {
    element.scrollTop = top;
    element.dispatchEvent(new Event("scroll"));
    await nextTick();
  };
  const pinned = () => Array.from(state.host.querySelectorAll<HTMLElement>("[data-redis-sticky-group]"));
  expect(natural(namespace(["a", "b", "c", "d"])).style.paddingLeft).toBe("48px");
  await scroll(1500);
  expect(pinned().map((node) => node.dataset.redisStickyGroup)).toEqual(["custom:unmatched", namespace(["a", "b", "c"]), namespace(["a", "b", "c", "d"])]);
  expect(pinned().map((node) => node.style.paddingLeft)).toEqual(["8px", "18px", "28px"]);
  expect(pinned()[1]!.textContent).toContain("…");
  expect(pinned()[1]!.querySelector("[data-redis-sticky-navigate]")!.getAttribute("aria-label")).toBe("c");
  expect(pinned()[1]!.querySelector('[role="tooltip"]')!.textContent).toContain("a › b › c › d");
  expect(pinned()[1]!.querySelectorAll("button button")).toHaveLength(0);
  expect(state.list.value!.getViewportAnchor()).toEqual({ rowIndex: 53, keyRaw: btoa(names[48]!) });
  state.checked.add(btoa(names[48]!));
  state.selected.value = btoa(names[48]!);
  pinned()[1]!.querySelector<HTMLButtonElement>("[data-redis-sticky-navigate]")!.click();
  await flushPublication();
  expect(natural(namespace(["a", "b", "c"])).getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(natural(namespace(["a", "b", "c"])));
  await scroll(1500);
  pinned()[1]!.querySelector<HTMLButtonElement>("[data-redis-sticky-toggle]")!.click();
  await flushPublication();
  expect(natural(namespace(["a", "b", "c"])).getAttribute("aria-expanded")).toBe("false");
  expect(pinned().some((node) => node.dataset.redisStickyGroup === namespace(["a", "b", "c", "d"]))).toBe(false);
  expect(document.activeElement).toBe(natural(namespace(["a", "b", "c"])));
  expect(state.checked).toEqual(new Set([btoa(names[48]!)]));
  expect(state.selected.value).toBe(btoa(names[48]!));
  expect(state.onCheck).not.toHaveBeenCalled();
  expect(state.onSelect).not.toHaveBeenCalled();
});
