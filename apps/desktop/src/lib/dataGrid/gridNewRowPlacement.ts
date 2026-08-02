/**
 * Display placement for pending draft rows in the data grid.
 *
 * Pending rows live in an append-ordered buffer and the database has no row
 * order of its own, so "insert above/below a selected row" is a display-only
 * concept that lasts until the pending changes are saved. Each pending row
 * carries an optional placement (anchor row + above/below); the anchor is
 * resolved at render time by `buildOrderedGridRows`, which merges the pending
 * rows into the loaded source rows accordingly.
 */

export type GridNewRowPosition = "above" | "below";

/** User-facing insert position state; `"end"` maps to a null placement. */
export type GridInsertRowPosition = GridNewRowPosition | "end";

export interface GridNewRowPlacement {
  /** Row id of the anchor: `>= 0` for a source row (its sourceIndex), `< 0` for another pending row (its stable token negated). */
  anchorId: number;
  position: GridNewRowPosition;
}

export interface GridNewRowMeta {
  /** Stable per-row token (> 0) that survives splices of the pending buffer. */
  token: number;
  /** Display placement; `null` appends at the end of the result. */
  placement: GridNewRowPlacement | null;
}

export type GridOrderedRowEntry = { kind: "source"; sourceIndex: number } | { kind: "new"; newIndex: number };

interface GridOrderedRowNode {
  entry: GridOrderedRowEntry;
  previous: GridOrderedRowNode | null;
  next: GridOrderedRowNode | null;
}

/**
 * Merge pending rows into the source rows in display order.
 *
 * `sourceIndices` is the loaded row order (server sort / local filter applied).
 * Rows anchored "below" a target cluster in creation order right after it; rows
 * anchored "above" cluster immediately before it. An anchor that is absent from
 * the current source order (its source row was filtered out, or the anchored
 * pending row was deleted) falls back to the end of the list.
 *
 * Anchors only ever reference rows that already exist, so processing pending
 * rows in creation order keeps every anchor placed before it is referenced.
 */
export function buildOrderedGridRows(sourceIndices: readonly number[], newRowMeta: readonly GridNewRowMeta[], newRowCount: number): GridOrderedRowEntry[] {
  const list: { head: GridOrderedRowNode | null; tail: GridOrderedRowNode | null } = {
    head: null,
    tail: null,
  };
  const sourceNodes = new Map<number, GridOrderedRowNode>();
  const pendingTokenNodes = new Map<number, GridOrderedRowNode>();
  const belowTailNodes = new Map<number, GridOrderedRowNode>();

  const append = (node: GridOrderedRowNode) => {
    if (!list.tail) {
      list.head = node;
      list.tail = node;
      return;
    }
    list.tail.next = node;
    node.previous = list.tail;
    list.tail = node;
  };

  const insertBefore = (anchor: GridOrderedRowNode, node: GridOrderedRowNode) => {
    node.previous = anchor.previous;
    node.next = anchor;
    if (anchor.previous) anchor.previous.next = node;
    else list.head = node;
    anchor.previous = node;
  };

  const insertAfter = (anchor: GridOrderedRowNode, node: GridOrderedRowNode) => {
    node.previous = anchor;
    node.next = anchor.next;
    if (anchor.next) anchor.next.previous = node;
    else list.tail = node;
    anchor.next = node;
  };

  for (const sourceIndex of sourceIndices) {
    const node: GridOrderedRowNode = {
      entry: { kind: "source", sourceIndex },
      previous: null,
      next: null,
    };
    append(node);
    if (!sourceNodes.has(sourceIndex)) sourceNodes.set(sourceIndex, node);
  }

  for (let index = 0; index < newRowCount; index++) {
    const meta = newRowMeta[index];
    const node: GridOrderedRowNode = {
      entry: { kind: "new", newIndex: index },
      previous: null,
      next: null,
    };
    const anchorId = meta?.placement?.anchorId;
    if (anchorId === undefined) {
      append(node);
      if (meta) pendingTokenNodes.set(meta.token, node);
      continue;
    }

    const anchorNode = anchorId >= 0 ? sourceNodes.get(anchorId) : pendingTokenNodes.get(-anchorId);
    if (!anchorNode) {
      append(node);
      pendingTokenNodes.set(meta.token, node);
      continue;
    }

    if (meta.placement!.position === "above") {
      insertBefore(anchorNode, node);
    } else {
      const insertAfterNode = belowTailNodes.get(anchorId) ?? anchorNode;
      insertAfter(insertAfterNode, node);
      belowTailNodes.set(anchorId, node);
    }
    pendingTokenNodes.set(meta.token, node);
  }

  const order: GridOrderedRowEntry[] = [];
  let current = list.head;
  while (current) {
    order.push(current.entry);
    current = current.next;
  }
  return order;
}
