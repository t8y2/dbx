// @vitest-environment happy-dom
import { createApp, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import ResultSetNavigatorPopoverContent from "../ResultSetNavigatorPopoverContent.vue";
import { filterResultItems, type ResultItem } from "../resultSetNavigator";
import { tabularResultItems } from "@/lib/tabs/tabPresentation";
import type { QueryResult } from "@/types/database";

let app: App | undefined;
afterEach(() => {
  app?.unmount();
  document.body.replaceChildren();
});

async function mountPopoverContent(
  options: {
    items?: ResultItem[];
    activeIndex?: number;
    active?: boolean;
    align?: "start" | "center" | "end";
  } = {},
) {
  const queryResults: QueryResult[] = [
    { columns: ["id"], rows: [[1]], sourceName: "first query", sourceStatement: "SELECT 1" },
    { columns: ["id"], rows: [[2]], sourceLabel: "second label", sourceStatement: "SELECT 2" },
    { columns: ["id"], rows: [[3]], sourceStatement: "SELECT 3" },
  ];
  const items = options.items ?? tabularResultItems(queryResults);
  const select = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);

  app = createApp({
    components: { Popover, PopoverTrigger, ResultSetNavigatorPopoverContent },
    setup() {
      return {
        items,
        activeIndex: options.activeIndex ?? 0,
        active: options.active ?? true,
        align: options.align ?? "start",
        select,
      };
    },
    template: `
      <Popover :open="true">
        <PopoverTrigger><button>Trigger</button></PopoverTrigger>
        <ResultSetNavigatorPopoverContent
          :items="items"
          :active-index="activeIndex"
          :active="active"
          :align="align"
          @select="select"
        />
      </Popover>
    `,
  });

  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: {
        en: {
          tabs: {
            resultN: "Result {n}",
            resultSets: "Result sets",
            searchResults: "Search",
            noMatchingResults: "No matches",
          },
        },
      },
    }),
  );

  app.mount(container);
  await nextTick();
  await nextTick();

  const popup = document.querySelector<HTMLElement>('[data-slot="popover-content"]')!;
  const searchInput = popup.querySelector<HTMLInputElement>('input[type="search"]')!;
  return { container, popup, searchInput, select, items };
}

describe("ResultSetNavigatorPopoverContent", () => {
  it("renders result items and shows checkmark on active item", async () => {
    const { popup } = await mountPopoverContent({ activeIndex: 1, active: true });
    const buttons = popup.querySelectorAll<HTMLButtonElement>('div[aria-label="Result sets"] button');
    expect(buttons).toHaveLength(3);

    expect(buttons[0]?.textContent).toContain("Result 1");
    expect(buttons[1]?.textContent).toContain("Result 2");
    expect(buttons[2]?.textContent).toContain("Result 3");

    // Item 1 is active (storage index 1), so button 1's svg should not have 'invisible'
    const check1 = buttons[1]?.querySelector("svg");
    expect(check1?.classList.contains("invisible")).toBe(false);

    // Button 0's svg should have 'invisible'
    const check0 = buttons[0]?.querySelector("svg");
    expect(check0?.classList.contains("invisible")).toBe(true);
  });

  it("filters items when typing in search input", async () => {
    const { popup, searchInput } = await mountPopoverContent();
    searchInput.value = "second";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    const buttons = popup.querySelectorAll<HTMLButtonElement>('div[aria-label="Result sets"] button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toContain("Result 2");
  });

  it("shows empty state when search query matches nothing", async () => {
    const { popup, searchInput } = await mountPopoverContent();
    searchInput.value = "nonexistent query";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    const buttons = popup.querySelectorAll<HTMLButtonElement>('div[aria-label="Result sets"] button');
    expect(buttons).toHaveLength(0);

    const empty = popup.querySelector('[role="status"]');
    expect(empty?.textContent).toBe("No matches");
  });

  it("emits select event when clicking an item", async () => {
    const { popup, select, items } = await mountPopoverContent();
    const buttons = popup.querySelectorAll<HTMLButtonElement>('div[aria-label="Result sets"] button');
    buttons[2]?.click();

    expect(select).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith(items[2]);
  });

  it("selects first matching item when pressing Enter in search input", async () => {
    const { searchInput, select, items } = await mountPopoverContent();
    searchInput.value = "3";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(select).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith(items[2]);
  });

  it("supports keyboard navigation with arrow keys, Home, and End", async () => {
    const { popup, searchInput } = await mountPopoverContent();
    const buttons = popup.querySelectorAll<HTMLButtonElement>('div[aria-label="Result sets"] button');

    // ArrowDown in search input focuses the first item
    searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);

    // ArrowDown on item moves to next item
    buttons[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(buttons[1]);

    // End moves to last item
    buttons[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(buttons[2]);

    // Home moves to first item
    buttons[2]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);

    // ArrowUp on first item returns focus to search input
    buttons[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(searchInput);

    // ArrowUp in search input focuses the last item
    searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(buttons[2]);
  });
});

describe("filterResultItems helper", () => {
  it("returns all items when query is empty or whitespace", () => {
    const queryResults: QueryResult[] = [
      { columns: ["id"], rows: [[1]], sourceStatement: "SELECT 1" },
      { columns: ["id"], rows: [[2]], sourceStatement: "SELECT 2" },
    ];
    const items = tabularResultItems(queryResults);
    const t = (key: string, params?: Record<string, unknown>) => (key === "tabs.resultN" ? `Result ${params?.n}` : key);

    expect(filterResultItems(items, "", t)).toEqual(items);
    expect(filterResultItems(items, "   ", t)).toEqual(items);
  });

  it("filters by exact ordinal when query is a number", () => {
    const queryResults: QueryResult[] = Array.from({ length: 15 }, (_, i) => ({
      columns: ["id"],
      rows: [[i + 1]],
      sourceStatement: `SELECT ${i + 1}`,
    }));
    const items = tabularResultItems(queryResults);
    const t = (key: string, params?: Record<string, unknown>) => (key === "tabs.resultN" ? `Result ${params?.n}` : key);

    const matched = filterResultItems(items, "12", t);
    expect(matched).toHaveLength(1);
    expect(matched[0]?.n).toBe(12);
  });
});
