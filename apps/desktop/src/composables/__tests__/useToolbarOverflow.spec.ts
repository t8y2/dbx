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
 * measure loop can converge instead of running to the max tier. scrollWidth
 * is clamped to clientWidth like a real row: once the condensed content fits,
 * the row reports no slack at all (per CSSOM, scrollWidth >= clientWidth),
 * which is exactly why step-down must rely on recorded tier requirements.
 */
function fakeRow(clientWidth: number, contentWidthAtTier: (tier: EditorToolbarTier) => number, tierSource: Ref<EditorToolbarTier>): HTMLElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: clientWidth, configurable: true });
  Object.defineProperty(element, "scrollWidth", {
    configurable: true,
    get: () => Math.max(element.clientWidth, contentWidthAtTier(tierSource.value)),
  });
  return element;
}

function setRowWidth(element: HTMLElement, clientWidth: number) {
  Object.defineProperty(element, "clientWidth", { value: clientWidth, configurable: true });
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

    const row = fakeRow(200, (tier) => (tier >= 1 ? 180 : 260), tierRef);
    rootRef.value = row;
    await flush();
    expect(tierRef.value).toBe(1);

    // Widening without enough growth keeps the condensed tier: the pane grew
    // 20px since the condensation (below the 64px hysteresis) and the
    // recorded tier-0 requirement (260px + 48px slack) does not fit either.
    // The explicit measure() stands in for the ResizeObserver event that a
    // real browser fires after the box resize.
    setRowWidth(row, 220);
    measure();
    expect(tierRef.value).toBe(1);
  });

  it("condenses tier by tier and caps at the max tier while still overflowing", async () => {
    const { rootRef, tierRef } = createHarness();

    rootRef.value = fakeRow(160, () => 400, tierRef);
    await flush();
    expect(tierRef.value).toBe(3);
  });

  it("steps down only after meaningful pane growth AND once the recorded requirement fits", async () => {
    const { rootRef, tierRef, measure } = createHarness();

    const row = fakeRow(200, (tier) => (tier >= 1 ? 180 : 260), tierRef);
    rootRef.value = row;
    await flush();
    expect(tierRef.value).toBe(1);

    // Grew by 10px only: below the 64px growth hysteresis, no step down even
    // though the pane is wider than the condensation width.
    setRowWidth(row, 210);
    measure();
    expect(tierRef.value).toBe(1);

    // Grew by 100px, but tier 0 needed 260px and the row cannot report slack
    // for itself (scrollWidth clamps to clientWidth once content fits), so
    // 300px is still below 260px + 48px slack: keep the condensed tier.
    setRowWidth(row, 300);
    measure();
    expect(tierRef.value).toBe(1);

    // 320px covers the recorded requirement plus slack: step down.
    setRowWidth(row, 320);
    measure();
    expect(tierRef.value).toBe(0);
  });

  it("restores the full layout after a side panel closes, like the data-grid header toolbar", async () => {
    const { rootRef, tierRef, measure } = createHarness();

    // The regression behind issue #15107: opening the history panel narrows
    // the data tab's header row, the row condenses to icon-only buttons, and
    // closing the panel must restore the labels once the width comes back.
    const row = fakeRow(900, (tier) => (tier >= 1 ? 520 : 700), tierRef);
    rootRef.value = row;
    await flush();
    expect(tierRef.value).toBe(0);

    // History panel opens: the row loses ~300px and condenses.
    setRowWidth(row, 600);
    measure();
    expect(tierRef.value).toBe(1);

    // History panel closes: the pane regrows by the panel width (well past
    // the growth hysteresis) and the recorded tier-0 requirement fits again.
    setRowWidth(row, 900);
    measure();
    expect(tierRef.value).toBe(0);
  });

  it("re-measures from the full layout when a revalidate source changes the control set", async () => {
    const flag = ref(0);
    const { rootRef, tierRef } = createHarness([() => flag.value]);
    let contentGrew = false;

    const row = fakeRow(200, (tier) => (tier >= 1 ? 140 : contentGrew ? 260 : 140), tierRef);
    rootRef.value = row;
    await flush();
    expect(tierRef.value).toBe(0);

    // A conditional control appeared: the content extent grew without the
    // toolbar box resizing (no ResizeObserver event) — only the source watch
    // re-measures this.
    contentGrew = true;
    flag.value += 1;
    await flush();
    expect(tierRef.value).toBe(1);

    // The conditional control disappeared: the stale tier measurements no
    // longer describe the row, so it re-converges from the full layout and
    // stays at tier 0 because the restored control set fits.
    contentGrew = false;
    flag.value += 1;
    await flush();
    expect(tierRef.value).toBe(0);
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
