// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import type { Ref, WatchSource } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useToolbarOverflow } from "../useToolbarOverflow";
import type { EditorToolbarTier } from "@/lib/tabs/editorToolbarLayout";

function createHarness(revalidateSources: WatchSource[] = []) {
  const rootRef = ref<HTMLElement | null>(null);
  let tierRef: Ref<EditorToolbarTier> | undefined;
  let measureFn: () => void = () => {};
  const app = createApp(
    defineComponent({
      setup() {
        const { tier, measure } = useToolbarOverflow(rootRef, revalidateSources);
        tierRef = tier;
        measureFn = measure;
        return () => h("div");
      },
    }),
  );
  app.mount(document.createElement("div"));
  return { rootRef, tierRef: tierRef!, measure: () => measureFn() };
}

/**
 * Fake toolbar row whose scrollWidth shrinks once a tier is condensed —
 * mirroring real rows where controls move into the overflow menu, so the
 * measure loop can converge instead of running to the max tier.
 */
function fakeRow(clientWidth: number, contentWidthAtTier: (tier: EditorToolbarTier) => number, tierSource: Ref<EditorToolbarTier>): HTMLElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: clientWidth, configurable: true });
  Object.defineProperty(element, "scrollWidth", { configurable: true, get: () => contentWidthAtTier(tierSource.value) });
  return element;
}

async function flush(ticks = 5) {
  for (let i = 0; i < ticks; i += 1) {
    await nextTick();
  }
}

describe("useToolbarOverflow", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("steps up while the row content overflows and keeps the tier when it merely fits again", async () => {
    const { rootRef, tierRef, measure } = createHarness();

    rootRef.value = fakeRow(200, (tier) => (tier >= 1 ? 180 : 260), tierRef);
    await flush();
    expect(tierRef.value).toBe(1);

    // Widening without enough growth keeps the condensed tier: the row fits
    // (slack 20px < 48px) and the pane grew 0px since the condensation. The
    // explicit measure() stands in for the ResizeObserver event that a real
    // browser fires after the box resize.
    Object.defineProperty(rootRef.value!, "clientWidth", { value: 220, configurable: true });
    measure();
    expect(tierRef.value).toBe(1);
  });

  it("condenses tier by tier and caps at the max tier while still overflowing", async () => {
    const { rootRef, tierRef } = createHarness();

    rootRef.value = fakeRow(160, () => 400, tierRef);
    await flush();
    expect(tierRef.value).toBe(3);
  });

  it("steps down only with real slack and meaningful pane growth", async () => {
    const { rootRef, tierRef, measure } = createHarness();

    rootRef.value = fakeRow(200, (tier) => (tier >= 1 ? 180 : 260), tierRef);
    await flush();
    expect(tierRef.value).toBe(1);

    // Grew by 10px only: below the 64px growth hysteresis, no step down even
    // though the condensed row now has slack.
    Object.defineProperty(rootRef.value!, "clientWidth", { value: 210, configurable: true });
    measure();
    expect(tierRef.value).toBe(1);

    // Grew by 100px with 70px slack: both step-down thresholds pass.
    Object.defineProperty(rootRef.value!, "clientWidth", { value: 300, configurable: true });
    measure();
    expect(tierRef.value).toBe(0);
  });

  it("re-measures when a revalidate source changes the control set", async () => {
    const flag = ref(0);
    const { rootRef, tierRef } = createHarness([() => flag.value]);
    let contentGrew = false;

    rootRef.value = fakeRow(200, (tier) => (tier >= 1 ? 180 : contentGrew ? 260 : 180), tierRef);
    await flush();
    expect(tierRef.value).toBe(0);

    // A conditional control appeared: the content extent grew without the
    // toolbar box resizing (no ResizeObserver event) — only the source watch
    // re-measures this.
    contentGrew = true;
    flag.value += 1;
    await flush();
    expect(tierRef.value).toBe(1);
  });

  it("starts from the full layout when a row re-attaches instead of inheriting a stale tier", async () => {
    const { rootRef, tierRef } = createHarness();

    rootRef.value = fakeRow(200, () => 400, tierRef);
    await flush();
    expect(tierRef.value).toBe(3);

    rootRef.value = fakeRow(300, () => 230, tierRef);
    await flush();
    expect(tierRef.value).toBe(0);
  });

  it("keeps the current tier while the row is unmeasured", async () => {
    const { rootRef, tierRef } = createHarness();

    rootRef.value = fakeRow(0, () => 0, tierRef);
    await flush();
    expect(tierRef.value).toBe(0);
  });
});
