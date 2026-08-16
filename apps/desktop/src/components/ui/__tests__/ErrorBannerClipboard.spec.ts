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

function selectRegion(region: HTMLElement) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(region);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

async function mountCardBanner() {
  const container = document.createElement("div");
  mountedContainers.push(container);
  document.body.append(container);

  const app = createApp(ErrorBanner, {
    variant: "card",
    title: "Save failed",
    message: "Conditional request failed",
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
    const container = await mountCardBanner();
    selectRegion(findNativeClipboardRegion(container, text));

    expect(
      eventTargetAllowsNativeClipboard({
        key: "c",
        metaKey: true,
        target: container,
      }),
    ).toBe(true);
  });

  it("leaves grid copy shortcuts active without a text selection", async () => {
    const container = await mountCardBanner();

    expect(
      eventTargetAllowsNativeClipboard({
        key: "c",
        metaKey: true,
        target: container,
      }),
    ).toBe(false);
  });
});
