import { buildMongoUpdateDocument, formatMongoShellLiteral, type MongoInputValue } from "@/lib/mongo/mongoDocumentValues";

export interface MongoQueryResultGridChanges {
  dirtyRows: Map<number, Map<number, MongoInputValue>>;
  deletedRows: Set<number>;
  columns: string[];
  rows: MongoInputValue[][];
}

export interface MongoQueryResultEditTarget {
  idColumn: string;
  /** Raw document behind a grid row, used for BSON-faithful `_id` values and field types. */
  documentAt: (rowIndex: number) => unknown;
}

export type MongoQueryResultOperation = { kind: "update"; rowIndex: number; id: unknown; update: Record<string, unknown> } | { kind: "delete"; rowIndex: number; id: unknown };

/**
 * Resolves the `_id` a mutation should target. The grid cell only carries a
 * display value, so prefer the raw document's `_id` to keep ObjectId/NumberLong
 * types intact, and skip rows whose id is blank (an unsaved or malformed row).
 */
function mongoQueryResultRowId(row: MongoInputValue[] | undefined, idColumnIndex: number, document: unknown): unknown {
  const fallback = row?.[idColumnIndex];
  if (fallback === null || fallback === undefined || String(fallback).trim() === "") return undefined;
  if (!document || typeof document !== "object" || Array.isArray(document)) return fallback;
  return (document as Record<string, unknown>)._id ?? fallback;
}

/**
 * Turns pending grid changes into the MongoDB mutations that apply them.
 * Updates come first so a shell preview reads in the same order it executes;
 * a row marked for deletion never carries dirty cells, since the grid drops
 * its edits when the row is marked.
 */
export function buildMongoQueryResultOperations(changes: MongoQueryResultGridChanges, target: MongoQueryResultEditTarget): MongoQueryResultOperation[] {
  const idColumnIndex = changes.columns.indexOf(target.idColumn);
  if (idColumnIndex < 0) return [];

  const operations: MongoQueryResultOperation[] = [];

  for (const [rowIndex, dirtyColumns] of changes.dirtyRows) {
    const document = target.documentAt(rowIndex);
    const id = mongoQueryResultRowId(changes.rows[rowIndex], idColumnIndex, document);
    if (id === undefined) continue;
    const update = buildMongoUpdateDocument(dirtyColumns, changes.columns, document);
    if (Object.keys(update).length === 0) continue;
    operations.push({ kind: "update", rowIndex, id, update });
  }

  for (const rowIndex of changes.deletedRows) {
    const id = mongoQueryResultRowId(changes.rows[rowIndex], idColumnIndex, target.documentAt(rowIndex));
    if (id === undefined) continue;
    operations.push({ kind: "delete", rowIndex, id });
  }

  return operations;
}

export function mongoCollectionExpression(collection: string): string {
  return `db.getCollection(${JSON.stringify(collection)})`;
}

export function formatMongoQueryResultOperationPreview(collection: string, operation: MongoQueryResultOperation): string {
  const filter = `{_id: ${formatMongoShellLiteral(operation.id)}}`;
  if (operation.kind === "delete") return `${mongoCollectionExpression(collection)}.deleteOne(${filter})`;
  return `${mongoCollectionExpression(collection)}.updateOne(${filter}, ${formatMongoShellLiteral(operation.update)})`;
}
