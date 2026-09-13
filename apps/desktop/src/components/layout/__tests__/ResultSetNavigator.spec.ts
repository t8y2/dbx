// @vitest-environment happy-dom
import { createApp, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResultSetNavigator from "../ResultSetNavigator.vue";
import { tabularResultItems } from "@/lib/tabs/tabPresentation";
import type { QueryResult } from "@/types/database";

let app: App | undefined;
afterEach(() => {
  app?.unmount();
  document.body.replaceChildren();
});

async function mountNavigator() {
  // Include a non-tabular result so ordinal and storage index are different.
  const results = [{ columns: [], rows: [] }, ...Array.from({ length: 100 }, (_, i) => ({ columns: ["value"], rows: [[i + 1]], sourceStatement: `SELECT ${i + 1} AS value` }))] as QueryResult[];
  const select = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  app = createApp(ResultSetNavigator, { items: tabularResultItems(results), activeIndex: 1, active: true, onSelect: select });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: { tabs: { resultN: "Result {n}", resultSets: "Result sets", allResults: "All results ({count})", searchResults: "Search", noMatchingResults: "No matches" } } } }));
  app.mount(container);
  await nextTick();
  return { container, select };
}

describe("large result-set navigation", () => {
  it("scrolls the result-set strip with a vertical wheel and consumes boundary gestures", async () => {
    const { container } = await mountNavigator();
    const strip = container.querySelector<HTMLElement>(".result-set-scroll")!;
    Object.defineProperties(strip, { clientWidth: { value: 400 }, scrollWidth: { value: 8000 } });
    const wheel = new WheelEvent("wheel", { deltaY: 200, bubbles: true, cancelable: true });
    strip.dispatchEvent(wheel);
    expect(strip.scrollLeft).toBe(200);
    expect(wheel.defaultPrevented).toBe(true);
    strip.scrollLeft = 7600;
    const boundary = new WheelEvent("wheel", { deltaY: 200, bubbles: true, cancelable: true });
    strip.dispatchEvent(boundary);
    expect(strip.scrollLeft).toBe(7600);
    expect(boundary.defaultPrevented).toBe(true);
  });

  it("finds an exact ordinal among 100 results and selects its original storage index", async () => {
    const { container, select } = await mountNavigator();
    const trigger = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("All results"))!;
    trigger.click();
    await nextTick();
    await nextTick();
    const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(input).toBeTruthy();
    input.value = "8";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    const popup = document.querySelector('[data-slot="popover-content"]')!;
    expect(popup.querySelectorAll("button")).toHaveLength(1);
    expect(popup.textContent).toContain("Result 8");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(select).toHaveBeenCalledOnce();
    expect(select.mock.calls[0]![0]).toMatchObject({ n: 8, index: 8 });
  });
});
