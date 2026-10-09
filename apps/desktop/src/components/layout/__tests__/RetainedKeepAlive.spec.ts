// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, onActivated, onDeactivated, onUnmounted, ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import RetainedKeepAlive from "../RetainedKeepAlive";
import { useRetainTabSurface } from "@/lib/tabs/retainTabSurface";

let app: ReturnType<typeof createApp> | undefined;
let host: HTMLDivElement;

afterEach(() => {
  app?.unmount();
  host?.remove();
});

function mountCache() {
  const active = ref("a");
  const surface = ref<{ id: string } | null>(null);
  const retain = new Map<string, () => () => void>();
  const activated: string[] = [];
  const deactivated: string[] = [];
  const unmounted: string[] = [];
  const Surface = defineComponent({
    props: { id: { type: String, required: true } },
    setup(props, { expose }) {
      const id = props.id;
      const value = ref("");
      retain.set(id, useRetainTabSurface());
      expose({ id });
      onActivated(() => activated.push(id));
      onDeactivated(() => deactivated.push(id));
      onUnmounted(() => unmounted.push(id));
      return () =>
        h("input", {
          value: value.value,
          onInput: (event: Event) => {
            value.value = (event.target as HTMLInputElement).value;
          },
        });
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({
    setup: () => () =>
      h(
        RetainedKeepAlive,
        { max: 3, cacheKey: active.value },
        {
          default: () => h(Surface, { key: active.value, id: active.value, ref: surface }),
        },
      ),
  });
  app.mount(host);
  const visit = async (id: string) => {
    active.value = id;
    await nextTick();
  };
  return { visit, surface, retain, activated, deactivated, unmounted };
}

describe("RetainedKeepAlive", () => {
  it("preserves pending surfaces, activation hooks and the active ref, then resumes eviction", async () => {
    const cache = mountCache();
    await nextTick();
    const input = host.querySelector("input")!;
    input.value = "pending draft";
    input.dispatchEvent(new Event("input"));
    const release = cache.retain.get("a")!();
    for (const id of ["b", "c", "d"]) await cache.visit(id);
    expect(cache.unmounted).toEqual(["b"]);
    expect(cache.deactivated).toContain("a");
    expect(cache.surface.value?.id).toBe("d");
    expect(host.querySelectorAll("input")).toHaveLength(1);

    await cache.visit("a");
    expect(host.querySelector("input")!.value).toBe("pending draft");
    expect(cache.activated.filter((id) => id === "a")).toHaveLength(2);
    expect(cache.surface.value?.id).toBe("a");

    release();
    for (const id of ["e", "f", "g"]) await cache.visit(id);
    expect(cache.unmounted).toContain("a");
    // Unmounting an inactive entry must not clear the active surface's ref.
    expect(cache.surface.value?.id).toBe("g");
    await cache.visit("a");
    expect(host.querySelector("input")!.value).toBe("");
  });

  it("reclaims overflow after all entries were busy, releasing only the final lease", async () => {
    const cache = mountCache();
    await nextTick();
    const first = cache.retain.get("a")!();
    const second = cache.retain.get("a")!();
    await cache.visit("b");
    const releaseB = cache.retain.get("b")!();
    await cache.visit("c");
    const releaseC = cache.retain.get("c")!();
    await cache.visit("d");
    expect(cache.unmounted).toEqual([]);

    first();
    first(); // Releasing one lease twice cannot release another operation's lease.
    await nextTick();
    expect(cache.unmounted).toEqual([]);
    second();
    await nextTick();
    await nextTick();
    expect(cache.unmounted).toEqual(["a"]);
    expect(cache.surface.value?.id).toBe("d");
    releaseB();
    releaseC();
    for (const id of ["e", "f", "g"]) await cache.visit(id);
    expect(cache.unmounted).toEqual(["a", "b", "c", "d"]);
  });
});
