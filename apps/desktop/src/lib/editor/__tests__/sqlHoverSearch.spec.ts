// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyHoverSearchHighlights, clearHoverSearchHighlights, createHoverSearch, findHoverSearchMatches } from "@/lib/editor/sqlHoverSearch";

const DDL = ["create table `orders` (", "    `id`                    bigint      not null,", "    `customer_order_status` varchar(32) null,", "    `USER_ID`               bigint      null,", "    `amount`                decimal(10,2) null", ");"].join("\n");

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("findHoverSearchMatches", () => {
  it("returns no matches for an empty or whitespace query", () => {
    expect(findHoverSearchMatches(DDL, "")).toEqual([]);
    expect(findHoverSearchMatches(DDL, "   ")).toEqual([]);
  });

  it("matches a full column name", () => {
    const matches = findHoverSearchMatches(DDL, "customer_order_status");
    expect(matches).toHaveLength(1);
    expect(DDL.slice(matches[0].start, matches[0].end)).toBe("customer_order_status");
  });

  it("matches a partial column name", () => {
    const matches = findHoverSearchMatches(DDL, "order");
    // Appears in table name `orders` and in `customer_order_status`.
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("is case-insensitive", () => {
    expect(findHoverSearchMatches(DDL, "user_id")).toHaveLength(1);
    expect(findHoverSearchMatches(DDL, "USER_ID")).toHaveLength(1);
    expect(findHoverSearchMatches(DDL, "User_Id")).toHaveLength(1);
  });

  it("returns an empty array when nothing matches", () => {
    expect(findHoverSearchMatches(DDL, "no_such_column")).toEqual([]);
  });

  it("treats regex metacharacters literally without throwing", () => {
    // None of these should be interpreted as a pattern.
    expect(() => findHoverSearchMatches(DDL, "(")).not.toThrow();
    expect(() => findHoverSearchMatches(DDL, "[a-z")).not.toThrow();
    expect(() => findHoverSearchMatches(DDL, "decimal(10,2)")).not.toThrow();
    expect(findHoverSearchMatches(DDL, "(10,2)")).toHaveLength(1);
    expect(findHoverSearchMatches(DDL, ".*")).toEqual([]);
  });

  it("finds non-overlapping repeated occurrences", () => {
    const matches = findHoverSearchMatches("aaaa", "aa");
    expect(matches).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });
});

describe("applyHoverSearchHighlights", () => {
  it("wraps matches in <mark> without altering the visible text", () => {
    const container = document.createElement("div");
    container.textContent = DDL;
    const matches = findHoverSearchMatches(DDL, "order");
    const marks = applyHoverSearchHighlights(container, matches);

    expect(marks.length).toBe(matches.length);
    expect(container.querySelectorAll("mark").length).toBe(matches.length);
    expect(container.textContent).toBe(DDL);
    // First match is tagged active for scroll-into-view.
    expect(marks[0].getAttribute("data-sql-hover-search-active")).toBe("true");
  });

  it("preserves surrounding highlight spans (only text nodes are split)", () => {
    const container = document.createElement("div");
    const span = document.createElement("span");
    span.style.color = "red";
    span.textContent = "customer_order_status";
    container.append(document.createTextNode("    "), span, document.createTextNode(" varchar"));

    const content = container.textContent!;
    const matches = findHoverSearchMatches(content, "order");
    applyHoverSearchHighlights(container, matches);

    // The colored span is still present and now contains the mark.
    const preservedSpan = container.querySelector("span");
    expect(preservedSpan?.style.color).toBe("red");
    expect(preservedSpan?.querySelector("mark")).not.toBeNull();
    expect(container.textContent).toBe(content);
  });

  it("clears highlights and restores the original text nodes", () => {
    const container = document.createElement("div");
    container.textContent = DDL;
    applyHoverSearchHighlights(container, findHoverSearchMatches(DDL, "id"));
    expect(container.querySelector("mark")).not.toBeNull();

    clearHoverSearchHighlights(container);
    expect(container.querySelector("mark")).toBeNull();
    expect(container.textContent).toBe(DDL);
  });

  it("groups fragments of one logical match across syntax-highlight spans", () => {
    const container = document.createElement("div");
    container.innerHTML = "<span>order</span><span>_id</span> + <span>order_id</span>";
    const originalText = container.textContent!;
    const marks = applyHoverSearchHighlights(container, findHoverSearchMatches(originalText, "order_id"));

    expect(marks.map((mark) => mark.getAttribute("data-sql-hover-search-match-index"))).toEqual(["0", "0", "1"]);
    expect(marks.map((mark) => mark.hasAttribute("data-sql-hover-search-active"))).toEqual([true, true, false]);
    expect(container.querySelectorAll("span")).toHaveLength(3);
    expect(container.textContent).toBe(originalText);
  });
});

describe("createHoverSearch", () => {
  function setup(html?: string) {
    const target = document.createElement("div");
    if (html === undefined) target.textContent = DDL;
    else target.innerHTML = html;
    const controller = createHoverSearch({
      target,
      originalHtml: target.innerHTML,
      placeholder: "Search columns…",
      noResultLabel: "No matching columns",
    });
    const input = controller.element.querySelector<HTMLInputElement>('[data-sql-hover-search-input="true"]')!;
    const count = controller.element.querySelector<HTMLElement>('[data-sql-hover-search-count="true"]')!;
    return { target, controller, input, count };
  }

  function pressKey(input: HTMLInputElement, key: string, options: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
    input.dispatchEvent(event);
    input.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, ...options }));
    return event;
  }

  function activeMarks(target: HTMLElement) {
    return [...target.querySelectorAll<HTMLElement>('[data-sql-hover-search-active="true"]')];
  }

  it("highlights correctly when line breaks render as <br> elements", () => {
    const target = document.createElement("div");
    // Mirror the syntax highlighter's inline output: lines separated by <br>,
    // so textContent contains no newline characters.
    const lines = DDL.split("\n");
    lines.forEach((line, index) => {
      if (index > 0) target.appendChild(document.createElement("br"));
      if (line) target.appendChild(document.createTextNode(line));
    });
    const controller = createHoverSearch({
      target,
      originalHtml: target.innerHTML,
      placeholder: "Search columns…",
      noResultLabel: "No matching columns",
    });
    const input = controller.element.querySelector<HTMLInputElement>('[data-sql-hover-search-input="true"]')!;

    // `customer_order_status` sits on the third line — two `<br>`s in, exactly
    // where newline-domain offsets used to drift into the wrong text.
    input.value = "customer_order_status";
    input.dispatchEvent(new Event("input"));

    const marks = target.querySelectorAll("mark");
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(mark.textContent?.toLowerCase()).toContain(input.value.toLowerCase());
    }
    expect(target.textContent?.toLowerCase()).toContain(input.value.toLowerCase());
  });

  it("creates a search input and a hidden no-result status", () => {
    const { controller, input } = setup();
    expect(input).not.toBeNull();
    expect(input.placeholder).toBe("Search columns…");
    expect(controller.status.hidden).toBe(true);
    expect(controller.status.textContent).toBe("No matching columns");
  });

  it("highlights matches as the query changes", () => {
    const { target, input } = setup();
    input.value = "customer_order_status";
    input.dispatchEvent(new Event("input"));
    expect(target.querySelectorAll("mark").length).toBe(1);
  });

  it("shows the no-result status and no marks when nothing matches", () => {
    const { target, controller, input } = setup();
    input.value = "zzz_missing";
    input.dispatchEvent(new Event("input"));
    expect(controller.status.hidden).toBe(false);
    expect(target.querySelector("mark")).toBeNull();
  });

  it("restores the full content when the query is cleared", () => {
    const { target, controller, input } = setup();
    input.value = "id";
    input.dispatchEvent(new Event("input"));
    expect(target.querySelector("mark")).not.toBeNull();

    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(target.querySelector("mark")).toBeNull();
    expect(controller.status.hidden).toBe(true);
    expect(target.textContent).toBe(DDL);
  });

  it("stops keydown propagation so the editor keymap never sees typing", () => {
    const { controller, input } = setup();
    let leaked = false;
    controller.element.addEventListener("keydown", () => (leaked = true));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(leaked).toBe(false);
  });

  it("clears the query on Escape but keeps propagation stopped (tooltip stays open)", () => {
    const { target, controller, input } = setup();
    input.value = "id";
    input.dispatchEvent(new Event("input"));
    let leaked = false;
    controller.element.addEventListener("keydown", () => (leaked = true));

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(input.value).toBe("");
    expect(target.querySelector("mark")).toBeNull();
    expect(leaked).toBe(false);
  });

  it("keeps pointerdown from bubbling to the editor (click focuses the input)", () => {
    const { controller, input } = setup();
    let leaked = false;
    controller.element.addEventListener("pointerdown", () => (leaked = true));
    input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(leaked).toBe(false);
  });

  it("removes its listeners on destroy", () => {
    const { target, controller, input } = setup();
    controller.destroy();
    input.value = "id";
    input.dispatchEvent(new Event("input"));
    // No re-render after destroy.
    expect(target.querySelector("mark")).toBeNull();
  });

  it("shows the current match count and cycles forward on Enter without rerendering", () => {
    const { target, controller, input, count } = setup("insurance_class + insurance_class AS insurance_class");
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    document.body.append(controller.element, target);
    input.focus();
    input.value = "insurance_class";
    input.dispatchEvent(new Event("input"));
    const marks = [...target.querySelectorAll("mark")];

    expect(count.hidden).toBe(false);
    expect(count.textContent).toBe("1 / 3");
    expect(count.getAttribute("role")).toBe("status");
    expect(count.getAttribute("aria-live")).toBe("polite");
    expect(activeMarks(target)).toEqual([marks[0]]);
    expect(scroll).toHaveBeenCalledTimes(1);

    for (const index of [1, 2, 0]) {
      expect(pressKey(input, "Enter").defaultPrevented).toBe(true);
      expect(count.textContent).toBe(`${index + 1} / 3`);
      expect(activeMarks(target)).toEqual([marks[index]]);
      expect(scroll.mock.instances.at(-1)).toBe(marks[index]);
    }

    expect(scroll).toHaveBeenCalledTimes(4);
    expect(target.querySelector("mark")).toBe(marks[0]);
    expect(document.activeElement).toBe(input);
  });

  it("cycles backward on Shift+Enter and handles one match", () => {
    const { target, input, count } = setup("id + id + id");
    input.value = "id";
    input.dispatchEvent(new Event("input"));

    pressKey(input, "Enter", { shiftKey: true });
    expect(count.textContent).toBe("3 / 3");
    pressKey(input, "Enter", { shiftKey: true });
    expect(count.textContent).toBe("2 / 3");

    input.value = "id + id + id";
    input.dispatchEvent(new Event("input"));
    pressKey(input, "Enter");
    pressKey(input, "Enter", { shiftKey: true });
    expect(count.textContent).toBe("1 / 1");
    expect(activeMarks(target)).toHaveLength(1);
  });

  it("counts cross-span matches once and navigates every fragment together", () => {
    const { target, input, count } = setup("<span>order</span><span>_id</span><br><span>order_id</span>");
    input.value = "order_id";
    input.dispatchEvent(new Event("input"));
    const marks = [...target.querySelectorAll("mark")];

    expect(marks).toHaveLength(3);
    expect(count.textContent).toBe("1 / 2");
    expect(activeMarks(target)).toEqual([marks[0], marks[1]]);
    pressKey(input, "Enter");
    expect(count.textContent).toBe("2 / 2");
    expect(activeMarks(target)).toEqual([marks[2]]);
    pressKey(input, "Enter");
    expect(activeMarks(target)).toEqual([marks[0], marks[1]]);
    expect(target.querySelectorAll("span")).toHaveLength(3);
    expect(target.querySelectorAll("br")).toHaveLength(1);
  });

  it("resets the active match when the query changes and hides the count on Escape", () => {
    const { target, controller, input, count } = setup();
    expect(count.hidden).toBe(true);
    input.value = "id";
    input.dispatchEvent(new Event("input"));
    pressKey(input, "Enter");
    expect(count.textContent).toBe("2 / 2");

    input.value = "order";
    input.dispatchEvent(new Event("input"));
    expect(count.textContent).toBe("1 / 2");
    expect(activeMarks(target)[0]).toBe(target.querySelector("mark"));
    pressKey(input, "Escape");
    expect(input.value).toBe("");
    expect(count.hidden).toBe(true);
    expect(count.textContent).toBe("");
    expect(controller.status.hidden).toBe(true);
    expect(target.textContent).toBe(DDL);
    expect(target.querySelector("mark")).toBeNull();
  });

  it("shows zero matches without scrolling and ignores navigation for blank queries", () => {
    const { target, controller, input, count } = setup();
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    input.value = "missing";
    input.dispatchEvent(new Event("input"));
    pressKey(input, "Enter");
    pressKey(input, "Enter", { shiftKey: true });
    expect(count.hidden).toBe(false);
    expect(count.textContent).toBe("0 / 0");
    expect(controller.status.hidden).toBe(false);
    expect(activeMarks(target)).toHaveLength(0);

    input.value = "   ";
    input.dispatchEvent(new Event("input"));
    pressKey(input, "Enter");
    expect(count.hidden).toBe(true);
    expect(controller.status.hidden).toBe(true);
    expect(scroll).not.toHaveBeenCalled();
  });

  it.each(["Enter", "Escape"])("preserves %s while the keyboard event is composing", (key) => {
    const { target, input } = setup("id + id");
    input.value = "id";
    input.dispatchEvent(new Event("input"));
    const firstMatch = activeMarks(target)[0];

    const event = pressKey(input, key, { isComposing: true });
    expect(event.defaultPrevented).toBe(false);
    expect(input.value).toBe("id");
    expect(activeMarks(target)).toEqual([firstMatch]);
  });

  it("uses composition lifecycle events when a key event omits isComposing", () => {
    const { target, input, count } = setup("id + id");
    input.value = "id";
    input.dispatchEvent(new Event("input"));
    const firstMatch = activeMarks(target)[0];
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));

    expect(pressKey(input, "Enter").defaultPrevented).toBe(false);
    expect(pressKey(input, "Escape").defaultPrevented).toBe(false);
    expect(input.value).toBe("id");
    expect(activeMarks(target)).toEqual([firstMatch]);

    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    pressKey(input, "Enter");
    expect(count.textContent).toBe("2 / 2");
  });

  it("ignores the legacy IME key code and does not clear on Escape keyup", () => {
    const { target, input } = setup("id + id");
    input.value = "id";
    input.dispatchEvent(new Event("input"));
    const firstMatch = activeMarks(target)[0];

    expect(pressKey(input, "Enter", { keyCode: 229 }).defaultPrevented).toBe(false);
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
    expect(input.value).toBe("id");
    expect(activeMarks(target)).toEqual([firstMatch]);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { altKey: true }])("does not navigate or leak modified Enter with %j", (modifiers) => {
    const { target, controller, input } = setup("id + id");
    const keydown = vi.fn();
    const keyup = vi.fn();
    controller.element.addEventListener("keydown", keydown);
    controller.element.addEventListener("keyup", keyup);
    input.value = "id";
    input.dispatchEvent(new Event("input"));
    const firstMatch = activeMarks(target)[0];

    pressKey(input, "Enter", modifiers);
    expect(activeMarks(target)).toEqual([firstMatch]);
    expect(keydown).not.toHaveBeenCalled();
    expect(keyup).not.toHaveBeenCalled();
  });

  it("stops navigation after destroy", () => {
    const { target, controller, input, count } = setup("id + id");
    input.value = "id";
    input.dispatchEvent(new Event("input"));
    const firstMatch = activeMarks(target)[0];
    controller.destroy();

    expect(pressKey(input, "Enter").defaultPrevented).toBe(false);
    expect(count.textContent).toBe("1 / 2");
    expect(activeMarks(target)).toEqual([firstMatch]);
  });
});
