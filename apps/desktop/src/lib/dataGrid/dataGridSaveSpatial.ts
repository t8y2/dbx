import type { DatabaseType } from "@/types/database";
import type { DataGridSaveStatementOptions, GridCellValue } from "./dataGridSql";
import { geometryColumnIndices } from "./geometryMapPreview";
import { looksLikeWkt } from "./geometryPreview";

export interface SpatialSaveMetadata {
  databaseType?: DatabaseType;
  columnTypes?: readonly string[];
  spatialColumns?: readonly { column_index: number; srid: number | null }[];
  spatialValues?: readonly (readonly (number | null)[])[];
}

/**
 * YashanDB needs the SRID to rebuild a `ST_GEOMETRY` value through
 * `ST_GeomFromText(wkt, srid)` during edit saves. The result grid carries the
 * SRID outside the cell value (`spatial_values` / `spatial_columns`), so embed
 * it as EWKT in the save payload only. The grid's visible values stay WKT.
 */
export function withYashanGeometrySrids<T extends DataGridSaveStatementOptions>(options: T, meta: SpatialSaveMetadata): T {
  if (meta.databaseType !== "yashandb") return options;
  const geometryIndexes = new Set(geometryColumnIndices(meta.columnTypes, meta.spatialColumns));
  if (geometryIndexes.size === 0) return options;

  const columnSrids = new Map((meta.spatialColumns ?? []).map((column) => [column.column_index, column.srid]));

  const toEwkt = (value: GridCellValue, rowIndex: number | undefined, columnIndex: number): GridCellValue => {
    if (typeof value !== "string") return value;
    const text = value.trim();
    if (!text || /^SRID\s*=/i.test(text) || /^0x/i.test(text) || !looksLikeWkt(text)) return value;
    const srid = (rowIndex === undefined ? undefined : meta.spatialValues?.[rowIndex]?.[columnIndex]) ?? columnSrids.get(columnIndex) ?? null;
    return srid != null && srid > 0 ? `SRID=${srid};${text}` : value;
  };

  // Only dirty/deleted rows feed rollback SET values and keyless predicates;
  // leaving untouched rows untouched avoids a full-matrix copy on large pages.
  const touchedRows = new Set<number>([...options.dirtyRows.map(([rowIndex]) => rowIndex), ...options.deletedRows]);
  const rows = options.rows.map((row, rowIndex) => (touchedRows.has(rowIndex) ? row.map((value, columnIndex) => (geometryIndexes.has(columnIndex) ? toEwkt(value, rowIndex, columnIndex) : value)) : row));
  const newRows = options.newRows.map((row) => row.map((value, columnIndex) => (geometryIndexes.has(columnIndex) ? toEwkt(value, undefined, columnIndex) : value)));
  const dirtyRows: DataGridSaveStatementOptions["dirtyRows"] = options.dirtyRows.map(([rowIndex, changes]) => [rowIndex, changes.map(([columnIndex, value]) => [columnIndex, geometryIndexes.has(columnIndex) ? toEwkt(value, rowIndex, columnIndex) : value])]);

  return { ...options, rows, newRows, dirtyRows } as T;
}
