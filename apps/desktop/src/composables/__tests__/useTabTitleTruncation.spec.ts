// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import type { Ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import { useTabTitleTruncation } from "../useTabTitleTruncation";

// happy-dom has no layout engine and no ResizeObserver, so the observer plumbing
// cannot be exercised here: these specs pin the measurement contract — which
// elements count as clipped and how the flag is aggregated — through the
// exposed measureTabTitleTruncation.
interface Harness {
  stripRef: Ref<HTMLElement | null>;
  hasTruncatedTabTitle: Ref<boolean>;
  measure: () => void;
}

let mounted: ReturnType<typeof createApp> | null = null;

function createHarness(): Harness {
  const stripRef = ref<HTMLElement | null>(null);
  let truncatedRef: Ref<boolean> | undefined;
  let measureFn: () => void = () => {};
  const app = createApp(
    defineComponent({
      setup() {
        const { hasTruncatedTabTitle, measureTabTitleTruncation } = useTabTitleTruncation(stripRef);
        truncatedRef = hasTruncatedTabTitle;
        measureFn = measureTabTitleTruncation;
        return () => h("div");
      },
    }),
  );
  app.mount(document.createElement("div"));
  mounted = app;
  return { stripRef, hasTruncatedTabTitle: truncatedRef!, measure: () => measureFn() };
}

/** A title element whose box is `boxWidth` wide while its text needs `contentWidth`. */
function title(attribute: "data-tab-title-base" | "data-tab-title-suffix", boxWidth: number, contentWidth: number): HTMLElement {
  const element = document.createElement("span");
  element.setAttribute(attribute, "");
  Object.defineProperty(element, "clientWidth", { value: boxWidth, configurable: true });
  Object.defineProperty(element, "scrollWidth", { value: contentWidth, configurable: true });
  return element;
}

function stripOf(...titles: HTMLElement[]): HTMLElement {
  const strip = document.createElement("div");
  strip.append(...titles);
  return strip;
}

async function attach(harness: Harness, strip: HTMLElement | null, ticks = 3): Promise<void> {
  harness.stripRef.value = strip;
  for (let i = 0; i < ticks; i += 1) {
    await nextTick();
  }
}

describe("useTabTitleTruncation", () => {
  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("reports a tab whose title is ellipsized", async () => {
    const harness = createHarness();
    await attach(harness, stripOf(title("data-tab-title-base", 120, 640)));

    harness.measure();

    expect(harness.hasTruncatedTabTitle.value).toBe(true);
  });

  it("stays hidden while every title fits, including sub-pixel rounding", async () => {
    const harness = createHarness();
    await attach(harness, stripOf(title("data-tab-title-base", 640, 640), title("data-tab-title-suffix", 90, 91)));

    harness.measure();

    expect(harness.hasTruncatedTabTitle.value).toBe(false);
  });

  it("treats a clipped title suffix as a hidden tab too", async () => {
    const harness = createHarness();
    await attach(harness, stripOf(title("data-tab-title-base", 120, 120), title("data-tab-title-suffix", 60, 180)));

    harness.measure();

    expect(harness.hasTruncatedTabTitle.value).toBe(true);
  });

  it("re-reads a replacement strip instead of keeping the old reading", async () => {
    const harness = createHarness();
    await attach(harness, stripOf(title("data-tab-title-base", 120, 640)));
    harness.measure();
    expect(harness.hasTruncatedTabTitle.value).toBe(true);

    await attach(harness, stripOf(title("data-tab-title-base", 640, 640)));
    harness.measure();

    expect(harness.hasTruncatedTabTitle.value).toBe(false);
  });

  it("reports no clipping while no strip is attached", async () => {
    const harness = createHarness();
    await attach(harness, stripOf(title("data-tab-title-base", 120, 640)));
    harness.measure();
    expect(harness.hasTruncatedTabTitle.value).toBe(true);

    await attach(harness, null);

    expect(harness.hasTruncatedTabTitle.value).toBe(false);
  });
});
