// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import type { Ref, WatchSource } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useMeasuredWidth } from "../useMeasuredWidth";

function createHarness(revalidateSources: WatchSource[] = []) {
  const targetRef = ref<HTMLElement | null>(null);
  let widthRef: Ref<number> | undefined;
  const app = createApp(
    defineComponent({
      setup() {
        widthRef = useMeasuredWidth(targetRef, 42, revalidateSources);
        return () => h("div");
      },
    }),
  );
  app.mount(document.createElement("div"));
  return { targetRef, widthRef: widthRef!, unmount: () => app.unmount() };
}

/** A bare element whose getBoundingClientRect reports the given width. */
function elementOfWidth(width: number): HTMLElement {
  const element = document.createElement("span");
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width, height: 0, top: 0, left: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) }),
  });
  return element;
}

async function flush(ticks = 5) {
  for (let i = 0; i < ticks; i += 1) {
    await nextTick();
  }
}

describe("useMeasuredWidth", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the fallback while no element is attached", async () => {
    const { targetRef, widthRef } = createHarness();
    expect(targetRef.value).toBeNull();
    await flush();
    expect(widthRef.value).toBe(42);
  });

  it("measures the element once attached", async () => {
    const { targetRef, widthRef } = createHarness();

    targetRef.value = elementOfWidth(90);
    await flush();
    expect(widthRef.value).toBe(90);
  });

  it("ignores a zero-width measurement instead of clobbering the previous width", async () => {
    const flag = ref(0);
    const { targetRef, widthRef } = createHarness([() => flag.value]);

    targetRef.value = elementOfWidth(90);
    await flush();
    expect(widthRef.value).toBe(90);

    // Zero width means "not laid out yet" (or display:none ancestry), never
    // "the text is zero pixels wide" — must not replace a usable width. Bump
    // the revalidate source so a re-measure actually runs against the
    // zero-width stub.
    Object.defineProperty(targetRef.value!, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) }),
    });
    flag.value += 1;
    await flush();
    expect(widthRef.value).toBe(90);
  });

  it("re-measures when a revalidate source changes (ResizeObserver-unavailable path)", async () => {
    const flag = ref(0);
    const { targetRef, widthRef } = createHarness([() => flag.value]);

    targetRef.value = elementOfWidth(70);
    await flush();
    expect(widthRef.value).toBe(70);

    // A locale swap changed the text: the element resized without moving, so
    // only the source watch picks it up.
    Object.defineProperty(targetRef.value!, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 91, height: 0, top: 0, left: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) }),
    });
    flag.value += 1;
    await flush();
    expect(widthRef.value).toBe(91);
  });

  it("re-binds and re-measures when the target element is swapped", async () => {
    const { targetRef, widthRef } = createHarness();

    targetRef.value = elementOfWidth(90);
    await flush();
    expect(widthRef.value).toBe(90);

    targetRef.value = elementOfWidth(120);
    await flush();
    expect(widthRef.value).toBe(120);
  });

  it("stays inert after unmount (observer disconnected, no stray throws)", async () => {
    const { targetRef, unmount } = createHarness();

    targetRef.value = elementOfWidth(90);
    await flush();
    expect(targetRef.value).not.toBeNull();

    unmount();
    // Mutating the stub and flushing must not throw once the app is gone.
    Object.defineProperty(targetRef.value!, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 200, height: 0, top: 0, left: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) }),
    });
    await flush();
  });
});
