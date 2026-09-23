/**
 * Search highlighting for the table-info DDL panel (#9212).
 *
 * The DDL is syntax-highlighted and rendered once; the search marks are then
 * applied straight to that rendered DOM. Rebuilding the highlighted HTML for
 * every keystroke used to re-parse the whole document (these DDLs are often
 * tens to hundreds of KB) and re-run the SQL highlighter, which made typing in
 * the DDL search box look like a freeze.
 */
export const DDL_SEARCH_MARK_CLASS = "ddl-search-match";

/** Removes every search mark, keeping the underlying DDL text untouched. */
export function clearDdlSearchMarks(pre: HTMLElement | null | undefined): void {
  if (!pre) return;
  const marks = Array.from(pre.querySelectorAll(`mark.${DDL_SEARCH_MARK_CLASS}`));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(pre.ownerDocument.createTextNode(mark.textContent ?? ""), mark);
    parent.normalize();
  }
}

/**
 * Rebuilds the search marks for `query` inside the rendered DDL.
 *
 * Only text nodes are searched, so a match never spans element boundaries —
 * the same limit the previous HTML-rewriting implementation had. Matching is
 * case-insensitive and literal (no regex), which keeps `(`, `%` and friends
 * from being interpreted as patterns.
 */
export function applyDdlSearchMarks(pre: HTMLElement | null | undefined, query: string): void {
  if (!pre) return;
  clearDdlSearchMarks(pre);
  const needle = query.toLowerCase();
  if (!needle) return;

  const textNodes: Text[] = [];
  const walker = pre.ownerDocument.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (walker.currentNode.nodeType === Node.TEXT_NODE) textNodes.push(walker.currentNode as Text);
  }

  for (const node of textNodes) {
    const text = node.nodeValue ?? "";
    if (!text) continue;
    const lowered = text.toLowerCase();
    // Some characters change length when lower-cased; fall back to a
    // case-sensitive scan so the match offsets stay aligned with `text`.
    const haystack = lowered.length === text.length ? lowered : text;
    const search = lowered.length === text.length ? needle : query;
    let index = haystack.indexOf(search);
    if (index === -1) continue;

    const fragment = pre.ownerDocument.createDocumentFragment();
    let cursor = 0;
    while (index !== -1) {
      if (index > cursor) fragment.appendChild(pre.ownerDocument.createTextNode(text.slice(cursor, index)));
      const mark = pre.ownerDocument.createElement("mark");
      mark.className = DDL_SEARCH_MARK_CLASS;
      mark.textContent = text.slice(index, index + search.length);
      fragment.appendChild(mark);
      cursor = index + search.length;
      index = haystack.indexOf(search, cursor);
    }
    if (cursor < text.length) fragment.appendChild(pre.ownerDocument.createTextNode(text.slice(cursor)));
    node.parentNode?.replaceChild(fragment, node);
  }
}
