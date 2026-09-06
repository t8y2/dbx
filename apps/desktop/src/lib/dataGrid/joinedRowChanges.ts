import type { CellValue } from "./cellValue";
import type { DataGridSaveStatementOptions, DataGridTableMeta } from "./dataGridSql";

export interface JoinedSaveTarget {
  tableMeta: DataGridTableMeta;
  sourceColumns: Array<string | undefined>;
}

/** Feed per-source changes through the existing SQL builder, including undo SQL. */
export function joinedSaveOptions(
  targets: JoinedSaveTarget[],
  options: Pick<DataGridSaveStatementOptions, "databaseType" | "identifierQuote" | "columns"> & {
    rows: CellValue[][];
    dirtyRows: Map<number, Map<number, CellValue>>;
    newRows: CellValue[][];
    deletedRows: Set<number>;
  },
): DataGridSaveStatementOptions[] {
  if (options.newRows.length || options.deletedRows.size) throw new Error("Joined results support updates only.");
  const sources = targets.map(({ tableMeta, sourceColumns }) => ({
    tableKey: JSON.stringify([tableMeta.catalog, tableMeta.database, tableMeta.schema, tableMeta.tableName]),
    primaryKeys: tableMeta.primaryKeys,
    sourceColumns,
  }));
  return joinedRowChanges(sources, options.rows, options.dirtyRows).map((update) => ({
    databaseType: options.databaseType,
    identifierQuote: options.identifierQuote,
    columns: options.columns,
    tableMeta: targets[update.sourceIndex]!.tableMeta,
    sourceColumns: targets[update.sourceIndex]!.sourceColumns,
    rows: options.rows,
    dirtyRows: [[update.rowIndex, [...update.changes]]],
    newRows: [],
    deletedRows: [],
  }));
}

export interface JoinedWriteSource {
  /** Physical table identity; aliases of the same table must share this key. */
  tableKey: string;
  primaryKeys: string[];
  sourceColumns: Array<string | undefined>;
}

export interface JoinedRowChange {
  sourceIndex: number;
  rowIndex: number;
  changes: Map<number, CellValue>;
}

/** Route each edited cell to its physical row, coalescing repeated JOIN rows. */
export function joinedRowChanges(sources: JoinedWriteSource[], rows: CellValue[][], dirtyRows: Map<number, Map<number, CellValue>>): JoinedRowChange[] {
  const updates = new Map<string, JoinedRowChange>();
  for (const [rowIndex, changes] of dirtyRows) {
    const row = rows[rowIndex];
    if (!row) throw new Error("The edited query row is no longer available.");
    for (const [columnIndex, value] of changes) {
      const owners = sources.flatMap((source, index) => (source.sourceColumns[columnIndex] === undefined ? [] : [index]));
      if (owners.length !== 1) throw new Error("The edited column does not have a unique source table.");
      const sourceIndex = owners[0]!;
      const source = sources[sourceIndex]!;
      if (!source.primaryKeys.length) throw new Error("A joined row requires a complete primary key.");
      const keys = source.primaryKeys.map((key) => {
        const positions = source.sourceColumns.flatMap((name, index) => (name === key ? [index] : []));
        if (!positions.length) throw new Error("A joined row requires a complete primary key.");
        const original = row[positions[0]!];
        if (original === null || original === undefined) throw new Error("Cannot update an unmatched outer-join row.");
        if (positions.some((position) => JSON.stringify(row[position]) !== JSON.stringify(original))) throw new Error("Conflicting primary key projections in the query result.");
        return original;
      });
      const identity = JSON.stringify([source.tableKey, keys]);
      let update = updates.get(identity);
      if (!update) {
        update = { sourceIndex, rowIndex, changes: new Map() };
        updates.set(identity, update);
      }
      // A self-join can project the same record through different aliases.
      const target = sources[update.sourceIndex]!;
      const columnName = source.sourceColumns[columnIndex]!;
      const targetIndex = target.sourceColumns.indexOf(columnName);
      if (targetIndex < 0) throw new Error("Repeated source rows have incompatible column projections.");
      if (update.changes.has(targetIndex) && JSON.stringify(update.changes.get(targetIndex)) !== JSON.stringify(value)) {
        throw new Error("Conflicting edits refer to the same source row and column.");
      }
      update.changes.set(targetIndex, value);
    }
  }
  return [...updates.values()];
}
