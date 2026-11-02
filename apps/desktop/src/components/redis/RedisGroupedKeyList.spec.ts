// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { defaultRedisKeyGrouping } from "@/lib/redis/redisKeyGrouping";
import RedisGroupedKeyList from "./RedisGroupedKeyList.vue";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const refresh = vi.fn();
const scroll = vi.fn();
let bound: unknown;
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    props: ["items"],
    setup(props, { slots, expose }) {
      bound = props.items;
      const epoch = ref(0);
      expose({
        findItemIndex: () => 0,
        getScroll: () => ({ start: 0 }),
        scrollToItem: scroll,
        updateVisibleItems: (changed: boolean) => {
          refresh(changed);
          epoch.value++;
        },
      });
      return () => {
        void epoch.value;
        return h(
          "div",
          Array.from(props.items as unknown[]).map((item) => slots.default?.({ item })),
        );
      };
    },
  }),
}));
afterEach(() => vi.clearAllMocks());

it("does not build a fuzzy tree over the existing limit or silently switch views", async () => {
  const config = { ...defaultRedisKeyGrouping(), enabled: true, inner_view: "tree" as const };
  const requestList = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(RedisGroupedKeyList, { keys: [], config, scope: "c:0", structureRevision: 0, separator: ":", selected: null, checked: new Set(), busy: false, metadataEpoch: 0, treeAllowed: false, onRequestList: requestList });
  app.mount(host);
  await nextTick();
  expect(host.querySelector(".redis-key-scroller")).toBeNull();
  expect(host.textContent).toContain("redisGrouping.fuzzyTreeUnavailable");
  expect(requestList).not.toHaveBeenCalled();
  expect(config.inner_view).toBe("tree");
  host.querySelector<HTMLButtonElement>("button")!.click();
  expect(requestList).toHaveBeenCalledOnce();
  app.unmount();
  host.remove();
});

it("headers have no check/delete controls and expanding is local", async () => {
  const config = { ...defaultRedisKeyGrouping(), enabled: true };
  const deleted = vi.fn();
  const scrolled = vi.fn();
  const resized = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(RedisGroupedKeyList, {
    keys: [{ key_raw: btoa("a"), key_display: "a", ttl: -1, key_type: "string" }],
    config,
    scope: "c:0",
    structureRevision: 0,
    separator: ":",
    selected: null,
    checked: new Set(),
    busy: false,
    metadataEpoch: 0,
    onDelete: deleted,
    onScroll: scrolled,
    onResize: resized,
  });
  app.mount(host);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  const original = bound;
  expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  expect(host.querySelectorAll("button")).toHaveLength(0);
  host.querySelector<HTMLElement>('[role="button"]')!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  expect(bound).toBe(original);
  expect(refresh).toHaveBeenCalledWith(true);
  expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  expect(deleted).not.toHaveBeenCalled();
  const element = host.querySelector<HTMLElement>(".redis-key-scroller")!;
  element.dispatchEvent(new Event("scroll"));
  element.dispatchEvent(new Event("resize"));
  expect(scrolled).toHaveBeenCalledOnce();
  expect(scrolled.mock.calls[0]![0].target).toBe(element);
  expect(resized).toHaveBeenCalledOnce();
  app.unmount();
  host.remove();
});
