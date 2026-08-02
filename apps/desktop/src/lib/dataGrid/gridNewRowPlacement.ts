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
  const order: GridOrderedRowEntry[] = sourceIndices.map((sourceIndex) => ({ kind: "source", sourceIndex }));
  const tokenToNewIndex = new Map<number, number>();
  newRowMeta.forEach((meta, index) => {
    if (index < newRowCount) tokenToNewIndex.set(meta.token, index);
  });
  // For "below" clusters, track the last inserted row's newIndex per anchor so a
  // second batch inserted below the same row lands after the first batch. The
  // tail is re-located by its stable newIndex because an "above" insert on the
  // same anchor shifts absolute positions.
  const belowTail = new Map<number, number>();

  for (let index = 0; index < newRowCount; index++) {
    const meta = newRowMeta[index];
    const entry: GridOrderedRowEntry = { kind: "new", newIndex: index };
    const anchorId = meta?.placement?.anchorId;
    if (anchorId === undefined) {
      order.push(entry);
      continue;
    }

    let anchorPos = -1;
    if (anchorId >= 0) {
      anchorPos = order.findIndex((candidate) => candidate.kind === "source" && candidate.sourceIndex === anchorId);
    } else {
      const targetNewIndex = tokenToNewIndex.get(-anchorId);
      if (targetNewIndex !== undefined) {
        anchorPos = order.findIndex((candidate) => candidate.kind === "new" && candidate.newIndex === targetNewIndex);
      }
    }
    if (anchorPos < 0) {
      order.push(entry);
      continue;
    }

    if (meta!.placement!.position === "above") {
      // Re-resolve the anchor each time: "above" groups grow before the anchor,
      // so inserting at the anchor's current position keeps creation order.
      order.splice(anchorPos, 0, entry);
    } else {
      const tailNewIndex = belowTail.get(anchorId);
      let insertPos: number;
      if (tailNewIndex === undefined) {
        insertPos = anchorPos;
      } else {
        insertPos = order.findIndex((candidate) => candidate.kind === "new" && candidate.newIndex === tailNewIndex);
        if (insertPos < 0) insertPos = anchorPos;
      }
      order.splice(insertPos + 1, 0, entry);
      belowTail.set(anchorId, index);
    }
  }
  return order;
}
