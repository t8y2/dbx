/**
 * Client-side search for the SQL table-structure hover tooltip.
 *
 * The hover already renders the full table DDL (syntax-highlighted). When a
 * table has many columns, finding one by eye is slow, so this module adds a
 * compact search box that highlights matches inside the *already fetched* DDL
 * text — no extra metadata or DDL request is made. Matching runs over the
 * container's `textContent` — the same offset domain the highlight walker
 * accumulates over its text nodes — never over the highlighted HTML, and uses
 * substring search (not a `RegExp` built from user input) so special
 * characters can never break matching. Keeping corpus and walker on the same
 * source matters because the syntax highlighter renders line breaks as `<br>`
 * elements: its `textContent` has no newline characters even though the raw
 * DDL string does.
 */

const MATCH_ATTRIBUTE = "data-sql-hover-search-match";
const ACTIVE_ATTRIBUTE = "data-sql-hover-search-active";

export interface HoverSearchMatch {
  /** Offset of the first matched character within the searched text. */
  start: number;
  /** Offset just past the last matched character within the searched text. */
  end: number;
}

/**
 * Find every case-insensitive, non-overlapping occurrence of `query` inside the
 * searched text. A blank/whitespace-only query yields no matches (the caller
 * treats this as "restore full content"). Uses `indexOf`, so arbitrary user
 * input — including regex metacharacters like `()[]$.*` — is matched literally.
 */
export function findHoverSearchMatches(text: string, query: string): HoverSearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const haystack = text.toLowerCase();
  const matches: HoverSearchMatch[] = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    matches.push({ start: index, end: index + needle.length });
    from = index + needle.length;
  }
  return matches;
}

/**
 * Wrap each matched range in a `<mark>` by walking the container's text nodes,
 * so the surrounding syntax-highlight spans are preserved untouched. A match
 * that straddles two adjacent text nodes is highlighted per node segment.
 * Match offsets are relative to the concatenated text-node content (the
 * container's `textContent`); call {@link clearHoverSearchHighlights} (or
 * restore the original HTML) before re-applying.
 *
 * Returns the created `<mark>` elements in document order; the first is tagged
 * as the active match so callers can scroll it into view.
 */
export function applyHoverSearchHighlights(container: HTMLElement, matches: HoverSearchMatch[]): HTMLElement[] {
  if (matches.length === 0) return [];

  // Snapshot text nodes with their global offsets before mutating the DOM.
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: Array<{ node: Text; start: number; end: number }> = [];
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const length = text.data.length;
    textNodes.push({ node: text, start: offset, end: offset + length });
    offset += length;
  }

  const marks: HTMLElement[] = [];
  for (const { node, start, end } of textNodes) {
    // Ranges (clamped to this node) that overlap the node, in node-local coords.
    const segments = matches.filter((match) => match.start < end && match.end > start).map((match) => ({ from: Math.max(match.start, start) - start, to: Math.min(match.end, end) - start }));
    if (segments.length === 0) continue;

    const data = node.data;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const { from, to } of segments) {
      if (from > cursor) fragment.appendChild(document.createTextNode(data.slice(cursor, from)));
      const mark = document.createElement("mark");
      mark.setAttribute(MATCH_ATTRIBUTE, "true");
      mark.className = "rounded-[2px] bg-yellow-300/70 px-px text-inherit dark:bg-yellow-500/40";
      mark.textContent = data.slice(from, to);
      fragment.appendChild(mark);
      marks.push(mark);
      cursor = to;
    }
    if (cursor < data.length) fragment.appendChild(document.createTextNode(data.slice(cursor)));
    node.replaceWith(fragment);
  }

  marks[0]?.setAttribute(ACTIVE_ATTRIBUTE, "true");
  return marks;
}

/** Remove every highlight mark, merging its text back into the surrounding nodes. */
export function clearHoverSearchHighlights(container: HTMLElement): void {
  const marks = container.querySelectorAll(`[${MATCH_ATTRIBUTE}]`);
  for (const mark of marks) mark.replaceWith(...mark.childNodes);
  container.normalize();
}

export interface HoverSearchController {
  /** Row element to insert above the scrollable DDL content. */
  element: HTMLElement;
  /** No-result status element (inserted after the content by the caller). */
  status: HTMLElement;
  /** Focus the search input. */
  focus(): void;
  /** Remove listeners; safe to call once when the tooltip is destroyed. */
  destroy(): void;
}

export interface HoverSearchOptions {
  /** Scrollable element whose innerHTML holds the rendered DDL. */
  target: HTMLElement;
  /** The target's pristine innerHTML, restored before every re-highlight. */
  originalHtml: string;
  /** Input placeholder text. */
  placeholder: string;
  /** Message shown when a non-empty query has no matches. */
  noResultLabel: string;
}

/**
 * Build the compact search box + no-result status for the hover tooltip and
 * wire live filtering. Interaction is isolated from the CodeMirror editor:
 *
 * - `pointerdown` stops propagation (but keeps default) so clicking the input
 *   focuses it without the editor treating it as "hover ended".
 * - `keydown`/`keyup` stop propagation so editor keymap shortcuts and IME
 *   Enter/composition never fire or dismiss the tooltip while typing.
 */
export function createHoverSearch(options: HoverSearchOptions): HoverSearchController {
  const { target, originalHtml, placeholder, noResultLabel } = options;

  const element = document.createElement("div");
  element.dataset.sqlHoverSearch = "true";
  element.className = "mt-2 flex-none";

  const input = document.createElement("input");
  input.type = "text";
  input.dataset.sqlHoverSearchInput = "true";
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  input.spellcheck = false;
  input.autocomplete = "off";
  input.className = "w-full rounded border border-border/60 bg-background px-2 py-1 text-[11px] leading-none text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  element.appendChild(input);

  const status = document.createElement("div");
  status.dataset.sqlHoverSearchEmpty = "true";
  status.className = "mt-1.5 text-[11px] text-muted-foreground";
  status.textContent = noResultLabel;
  status.hidden = true;

  const runSearch = () => {
    // Restore the pristine highlighted DDL, then re-apply match highlights.
    target.innerHTML = originalHtml;
    const query = input.value;
    // Search the rendered text, not the raw DDL string: the highlighter emits
    // `<br>` for line breaks, so `textContent` differs from the raw DDL by the
    // dropped newline characters — and the walker's offsets live in the
    // `textContent` domain. Using any other corpus shifts every match after
    // the first line.
    const matches = findHoverSearchMatches(target.textContent ?? "", query);
    if (!query.trim()) {
      status.hidden = true;
      return;
    }
    if (matches.length === 0) {
      status.hidden = false;
      return;
    }
    status.hidden = true;
    const marks = applyHoverSearchHighlights(target, matches);
    marks[0]?.scrollIntoView({ block: "nearest" });
  };

  const stopKeyboard = (event: KeyboardEvent) => {
    // Keep editor keymap shortcuts and IME Enter/Escape from leaking out of the
    // input; Escape clears the search but keeps the tooltip open.
    event.stopPropagation();
    if (event.key === "Escape" && input.value) {
      event.preventDefault();
      input.value = "";
      runSearch();
    }
  };
  const stopPointer = (event: Event) => {
    event.stopPropagation();
  };

  input.addEventListener("input", runSearch);
  input.addEventListener("keydown", stopKeyboard);
  input.addEventListener("keyup", stopKeyboard);
  input.addEventListener("pointerdown", stopPointer);
  input.addEventListener("mousedown", stopPointer);

  return {
    element,
    status,
    focus() {
      input.focus();
    },
    destroy() {
      input.removeEventListener("input", runSearch);
      input.removeEventListener("keydown", stopKeyboard);
      input.removeEventListener("keyup", stopKeyboard);
      input.removeEventListener("pointerdown", stopPointer);
      input.removeEventListener("mousedown", stopPointer);
    },
  };
}
