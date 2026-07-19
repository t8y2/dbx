import type { CellPosition, CellSelectionRange } from "@/lib/dataGrid/gridSelection";

export type GridCoordinate = CellPosition;
export type GridRange = CellSelectionRange;

export interface GridEditPatch<Row = unknown, Value = unknown> {
  rowIndex: number;
  columnIndex: number;
  previousValue: Value;
  nextValue: Value;
  row: Row;
}

export interface GridColumnLayout {
  order: readonly string[];
  hidden: ReadonlySet<string>;
  pinned: ReadonlySet<string>;
  widths: Readonly<Record<string, number>>;
}

export interface DataGridRuntimeScope {
  readonly disposed: boolean;
  addCleanup(cleanup: () => void): () => void;
  dispose(): void;
}

export interface DataGridCapability {
  readonly name: string;
  dispose?(): void;
}

export interface DataGridSelectionCapability extends DataGridCapability {
  getRange(): GridRange | null;
  setRange(range: GridRange | null): void;
  isSelected(position: GridCoordinate): boolean;
}

export interface DataGridNavigationCapability extends DataGridCapability {
  moveFocus(position: GridCoordinate, direction: "up" | "down" | "left" | "right" | "home" | "end"): GridCoordinate;
}

export interface DataGridEditAdapter<Row = unknown, Value = unknown, Patch = GridEditPatch<Row, Value>> {
  canEditCell(row: Row, columnIndex: number): boolean;
  createPatch(input: GridEditPatch<Row, Value>): Patch | null;
  applyPatch(patch: Patch): Promise<void> | void;
}

export interface DataGridRuntimeDependencies<Result = unknown> {
  readonly result: Result;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly registerCleanup: DataGridRuntimeScope["addCleanup"];
}

export function createDataGridRuntimeScope(): DataGridRuntimeScope {
  const cleanups: Array<() => void> = [];
  let disposed = false;

  return {
    get disposed() {
      return disposed;
    },
    addCleanup(cleanup) {
      if (disposed) {
        cleanup();
        return () => undefined;
      }

      cleanups.push(cleanup);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        const index = cleanups.indexOf(cleanup);
        if (index >= 0) cleanups.splice(index, 1);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    },
  };
}
