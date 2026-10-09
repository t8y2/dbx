import * as api from "@/lib/backend/api";
import type { LargeValueRequest, LargeValueChunk } from "@/lib/backend/http";
import type { QueryResult } from "@/types/database";

const MAX_MATERIALIZED_BYTES = 16 * 1024 * 1024;

/** No cache: every request validates the original server locator's lifecycle. */
export async function readLargeValueSnapshot(
  request: LargeValueRequest,
  isCurrent: () => boolean,
  consume: (chunk: LargeValueChunk) => Promise<void> | void,
): Promise<void> {
  let offset = 0;
  while (true) {
    if (!isCurrent()) throw new Error("LOB result context changed");
    const chunk = await api.readLargeValueChunk({ ...request, offset, limit: 4096 });
    if (!isCurrent()) throw new Error("LOB result context changed");
    if (chunk.status !== "ok") throw new Error(`LOB snapshot ${chunk.status}; execute the query again`);
    if (typeof chunk.data !== "string" || typeof chunk.eof !== "boolean" || (chunk.value_kind !== "text" && chunk.value_kind !== "binary")) throw new Error("Invalid LOB chunk payload");
    if (!Number.isSafeInteger(chunk.next_offset) || chunk.next_offset < offset || (!chunk.eof && chunk.next_offset === offset)) {
      throw new Error("Invalid LOB chunk offset");
    }
    const amount = chunk.next_offset - offset;
    if (amount > 4096 || chunk.value_kind === "text" && Array.from(chunk.data).length !== amount) {
      throw new Error("Invalid LOB chunk character count");
    }
    if (chunk.value_kind === "binary" && (!/^(?:[0-9a-f]{2})*$/i.test(chunk.data) || chunk.data.length / 2 !== amount)) {
      throw new Error("Invalid LOB chunk binary encoding");
    }
    await consume(chunk);
    if (!isCurrent()) throw new Error("LOB result context changed");
    if (chunk.eof) return;
    offset = chunk.next_offset;
  }
}

export async function materializeLargeValueSnapshot(request: LargeValueRequest, isCurrent: () => boolean): Promise<string> {
  const chunks: string[] = [];
  let bytes = 0;
  let kind: LargeValueChunk["value_kind"] | undefined;
  await readLargeValueSnapshot(request, isCurrent, (chunk) => {
    if (kind && kind !== chunk.value_kind) throw new Error("LOB chunk type changed");
    kind = chunk.value_kind;
    bytes += chunk.value_kind === "binary" ? chunk.data.length / 2 : new TextEncoder().encode(chunk.data).length;
    if (bytes > MAX_MATERIALIZED_BYTES) throw new Error("LOB exceeds the 16 MiB view/copy limit; download the complete value instead");
    chunks.push(chunk.data);
  });
  return (kind === "binary" ? "0x" : "") + chunks.join("");
}

export async function materializeSnapshotResultRows(result: QueryResult, isCurrent: () => boolean): Promise<QueryResult["rows"]> {
  const cells = result.large_value_cells ?? [];
  if (!cells.some((cell) => cell.value_ref)) return result.rows;
  const context = result.large_value_context;
  if (!context) throw new Error("LOB result connection is unavailable; execute the query again");
  const rows = result.rows.map((row) => [...row]);
  let totalBytes = 0;
  for (const cell of cells) {
    if (!cell.value_ref) throw new Error("This result includes a value without a snapshot reference");
    const value = await materializeLargeValueSnapshot({ ...context, valueRef: cell.value_ref }, isCurrent);
    totalBytes += new TextEncoder().encode(value).length;
    if (totalBytes > 64 * 1024 * 1024) throw new Error("LOB result exceeds the 64 MiB export limit; download individual complete values");
    const row = rows[cell.row_index];
    if (!row || cell.column_index >= row.length) throw new Error("LOB result column is unavailable");
    row[cell.column_index] = value;
  }
  return rows;
}
