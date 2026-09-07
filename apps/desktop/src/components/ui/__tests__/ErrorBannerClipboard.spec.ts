// @vitest-environment happy-dom

import { createApp, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it } from "vitest";
import ErrorBanner from "@/components/ui/ErrorBanner.vue";
import { eventTargetAllowsNativeClipboard } from "@/lib/common/clipboard";

const mountedContainers: HTMLDivElement[] = [];

function findNativeClipboardRegion(container: HTMLElement, text: string): HTMLElement {
  const region = Array.from(container.querySelectorAll<HTMLElement>("[data-native-clipboard]")).find((element) => element.textContent?.trim() === text);
  if (!region) throw new Error(`Native clipboard region not found: ${text}`);
  return region;
}

// The centered variant's clipboard region wraps title + message in one node,
// so match by containment instead of exact text.
function findClipboardRegionContaining(container: HTMLElement, text: string): HTMLElement {
  const region = Array.from(container.querySelectorAll<HTMLElement>("[data-native-clipboard]")).find((element) => element.textContent?.includes(text));
  if (!region) throw new Error(`Native clipboard region not found containing: ${text}`);
  return region;
}

function selectRegion(region: HTMLElement) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(region);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

async function mountBanner(variant: "card" | "centered", message: string) {
  const container = document.createElement("div");
  mountedContainers.push(container);
  document.body.append(container);

  const app = createApp(ErrorBanner, {
    variant,
    title: "Save failed",
    message,
  });
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: { en: { grid: { copy: "Copy", dismiss: "Dismiss" } } },
      missingWarn: false,
      fallbackWarn: false,
    }),
  );
  app.mount(container);
  await nextTick();
  return container;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  for (const container of mountedContainers.splice(0)) container.remove();
});

describe("ErrorBanner native clipboard selection", () => {
  it.each(["Save failed", "Conditional request failed"])("preserves native copy for selected %s text", async (text) => {
    const container = await mountBanner("card", "Conditional request failed");
    selectRegion(findNativeClipboardRegion(container, text));

    expect(
      eventTargetAllowsNativeClipboard({
        key: "c",
        metaKey: true,
        target: container,
      }),
    ).toBe(true);
  });

  it("preserves native copy for selected centered error message", async () => {
    const container = await mountBanner("centered", "fatal error\n\nlong detail line");
    selectRegion(findClipboardRegionContaining(container, "long detail line"));

    expect(
      eventTargetAllowsNativeClipboard({
        key: "c",
        metaKey: true,
        target: container,
      }),
    ).toBe(true);
  });

  it("leaves grid copy shortcuts active without a text selection", async () => {
    const container = await mountBanner("card", "Conditional request failed");

    expect(
      eventTargetAllowsNativeClipboard({
        key: "c",
        metaKey: true,
        target: container,
      }),
    ).toBe(false);
  });
});
