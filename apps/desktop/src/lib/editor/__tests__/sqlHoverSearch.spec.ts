// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { applyHoverSearchHighlights, clearHoverSearchHighlights, createHoverSearch, findHoverSearchMatches } from "@/lib/editor/sqlHoverSearch";

const DDL = ["create table `orders` (", "    `id`                    bigint      not null,", "    `customer_order_status` varchar(32) null,", "    `USER_ID`               bigint      null,", "    `amount`                decimal(10,2) null", ");"].join("\n");

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
});

describe("createHoverSearch", () => {
  function setup() {
    const target = document.createElement("div");
    target.textContent = DDL;
    const controller = createHoverSearch({
      target,
      originalHtml: target.innerHTML,
      placeholder: "Search columns…",
      noResultLabel: "No matching columns",
    });
    const input = controller.element.querySelector<HTMLInputElement>('[data-sql-hover-search-input="true"]')!;
    return { target, controller, input };
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
    const { input } = setup();
    let leaked = false;
    document.addEventListener("keydown", () => (leaked = true));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(leaked).toBe(false);
  });

  it("clears the query on Escape but keeps propagation stopped (tooltip stays open)", () => {
    const { target, input } = setup();
    input.value = "id";
    input.dispatchEvent(new Event("input"));
    let leaked = false;
    document.addEventListener("keydown", () => (leaked = true));

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(input.value).toBe("");
    expect(target.querySelector("mark")).toBeNull();
    expect(leaked).toBe(false);
  });

  it("keeps pointerdown from bubbling to the editor (click focuses the input)", () => {
    const { input } = setup();
    let leaked = false;
    document.addEventListener("pointerdown", () => (leaked = true));
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
});
