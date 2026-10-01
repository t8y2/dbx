import type { QueryResult } from "@/types/database";

type CellValue = QueryResult["rows"][number][number];

export interface Neo4jNodeProperty {
  name: string;
  type: string;
  value: CellValue;
}

export interface Neo4jNodeCell {
  row_index: number;
  column_index: number;
  properties: Neo4jNodeProperty[];
}

function isCellValue(value: unknown): value is CellValue {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function nodeEnvelope(value: unknown): { display: string; properties: Neo4jNodeProperty[] } | undefined {
  if (!value || typeof value !== "object") return;
  const cell = value as Record<string, unknown>;
  if (cell.__dbx_neo4j_node !== "v1" || typeof cell.display !== "string" || !Array.isArray(cell.properties)) return;
  const names = new Set<string>();
  for (const value of cell.properties) {
    if (!value || typeof value !== "object") return;
    const property = value as Record<string, unknown>;
    if (typeof property.name !== "string" || typeof property.type !== "string" || !isCellValue(property.value) || names.has(property.name)) return;
    names.add(property.name);
  }
  return { display: cell.display, properties: cell.properties as Neo4jNodeProperty[] };
}

/** Normalize typed wire cells once, keeping primitive rows and original columns. */
export function extractNeo4jNodeCells(result: QueryResult): void {
  let rows: QueryResult["rows"] | undefined;
  let cells: Neo4jNodeCell[] | undefined;
  result.rows.forEach((row, row_index) => {
    row.forEach((value, column_index) => {
      if (column_index >= result.columns.length) return;
      const cell = nodeEnvelope(value);
      if (!cell) return;
      rows ??= result.rows.map((row) => [...row]);
      cells ??= [...(result.neo4j_node_cells ?? [])];
      rows[row_index]![column_index] = cell.display;
      cells.push({ row_index, column_index, properties: cell.properties });
    });
  });
  if (rows) result.rows = rows;
  if (cells) result.neo4j_node_cells = cells;
}

export function appendNeo4jNodeCells(previous: QueryResult, segment: QueryResult, appendedRowCount: number): Neo4jNodeCell[] | undefined {
  const cells = [...(previous.neo4j_node_cells ?? []), ...(segment.neo4j_node_cells ?? []).filter((cell) => cell.row_index < appendedRowCount).map((cell) => ({ ...cell, row_index: cell.row_index + previous.rows.length }))];
  return cells.length ? cells : undefined;
}

/** Append alias-qualified properties without changing source ordinals or cursors. */
export function projectNeo4jNodeResult(result: QueryResult): QueryResult {
  if (!result.neo4j_node_cells?.length) return result;
  const columns = [...result.columns];
  const types = result.columns.map((_, index) => result.column_types?.[index] ?? "Unknown");
  const usedNames = new Set(columns);
  const propertiesByColumn = new Map<number, Map<string, number>>();
  const nodeRowsByColumn = new Map<number, Set<number>>();
  const keepOriginal = new Set<number>();
  const propertyTypes = new Map<number, Set<string>>();
  const cells = result.neo4j_node_cells.filter((cell) => cell.row_index >= 0 && cell.row_index < result.rows.length && cell.column_index >= 0 && cell.column_index < result.columns.length);
  for (const cell of cells) {
    const source = cell.column_index;
    let nodeRows = nodeRowsByColumn.get(source);
    if (!nodeRows) nodeRowsByColumn.set(source, (nodeRows = new Set()));
    nodeRows.add(cell.row_index);
    if (cell.properties.length === 0) keepOriginal.add(source);
    let properties = propertiesByColumn.get(source);
    if (!properties) propertiesByColumn.set(source, (properties = new Map()));
    for (const property of cell.properties) {
      let index = properties.get(property.name);
      if (index === undefined) {
        const base = `${result.columns[source]}.${property.name}`;
        let name = base;
        for (let suffix = 2; usedNames.has(name); suffix++) name = `${base} (${suffix})`;
        index = columns.length;
        columns.push(name);
        usedNames.add(name);
        properties.set(property.name, index);
        propertyTypes.set(index, new Set());
      }
      if (property.type !== "Null") propertyTypes.get(index)!.add(property.type);
    }
  }
  if (columns.length === result.columns.length) return result;
  for (const [index, observed] of propertyTypes) types[index] = observed.size === 1 ? [...observed][0]! : observed.size === 0 ? "Null" : "Any";
  const rows = result.rows.map((row) => [...row, ...Array<CellValue>(columns.length - result.columns.length).fill(null)]);
  for (const cell of cells) {
    for (const property of cell.properties) rows[cell.row_index]![propertiesByColumn.get(cell.column_index)!.get(property.name)!] = property.value;
  }
  const hidden = new Set(result.hidden_column_indexes);
  for (const [source, nodeRows] of nodeRowsByColumn) {
    // Empty nodes and mixed scalar/node columns must retain their source value.
    if (!keepOriginal.has(source) && result.rows.every((row, index) => row[source] == null || nodeRows.has(index))) hidden.add(source);
  }
  return {
    ...result,
    columns,
    column_types: types,
    column_sortables: columns.map((_, index) => result.column_sortables?.[index] ?? true),
    hidden_column_indexes: [...hidden],
    rows,
    neo4j_node_cells: undefined,
    spatial_values: result.spatial_values?.map((row) => [...row, ...Array<number | null>(columns.length - result.columns.length).fill(null)]),
  };
}
