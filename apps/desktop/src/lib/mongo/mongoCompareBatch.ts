import { compareMongoDocuments, type MongoCompareOptions, type MongoCompareResult } from "./mongoCompare";
import { MongoCompareError, readMongoCompareSnapshot, type MongoCompareApi, type MongoCompareEndpoint } from "./mongoCompareRuntime";

export interface MongoCollectionPair {
  source: string;
  target: string;
  enabled: boolean;
  /** An empty value inherits the dialog's matching fields. */
  matchFields: string;
}

export interface MongoCompareMetadataApi {
  mongoListCollections(connectionId: string, database: string): Promise<{ name: string; kind?: string }[]>;
}

export interface MongoBatchSummary {
  pair: MongoCollectionPair;
  state: "pending" | "running" | "complete" | "failed" | "cancelled" | "stale";
  counts?: MongoCompareResult["counts"];
  truncated?: boolean;
  durationMs?: number;
  error?: unknown;
}

export function mongoCompareFields(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((field) => field.trim())
        .filter(Boolean),
    ),
  ];
}

export function validMongoMatchFields(fields: string[]): boolean {
  return fields.length > 0 && fields.every((key) => key.split(".").every((part) => part && !part.startsWith("$") && !part.includes("\0")));
}

export function mongoPairKey(pair: Pick<MongoCollectionPair, "source" | "target">): string {
  return JSON.stringify([pair.source, pair.target]);
}

/** Preserve manual mappings; append only still-unmapped, identically named collections. */
export function matchMongoCollections(source: string[], target: string[], existing: MongoCollectionPair[]): MongoCollectionPair[] {
  const usedSource = new Set(existing.map((pair) => pair.source));
  const usedTarget = new Set(existing.map((pair) => pair.target));
  const targets = new Set(target);
  return [...existing, ...source.filter((name) => targets.has(name) && !usedSource.has(name) && !usedTarget.has(name)).map((name) => ({ source: name, target: name, enabled: true, matchFields: "" }))];
}

/** A deleted/renamed namespace must never appear to be an empty collection. */
export async function requireMongoCompareCollections(api: MongoCompareMetadataApi, source: MongoCompareEndpoint, target: MongoCompareEndpoint): Promise<void> {
  const lists = await Promise.all([source, target].map((side) => api.mongoListCollections(side.connectionId, side.database)));
  for (const [index, side] of [source, target].entries()) {
    if (!lists[index].some((item) => item.name === side.collection && item.kind !== "bucket")) throw new MongoCompareError("collectionMissing", `${side.database}.${side.collection}`);
  }
}

/** Read-only batch summaries retain no documents; detailed sync always reads a fresh pair. */
export async function compareMongoBatch(
  api: MongoCompareApi & MongoCompareMetadataApi,
  source: MongoCompareEndpoint,
  target: MongoCompareEndpoint,
  pairs: MongoCollectionPair[],
  options: MongoCompareOptions & { limit: number; signal: AbortSignal; executionIds: [string, string] },
  onUpdate: (index: number, summary: MongoBatchSummary) => void,
): Promise<void> {
  for (const [index, pair] of pairs.entries()) {
    if (options.signal.aborted) {
      onUpdate(index, { pair, state: "cancelled" });
      continue;
    }
    onUpdate(index, { pair, state: "running" });
    const start = performance.now();
    try {
      const leftEndpoint = { ...source, collection: pair.source };
      const rightEndpoint = { ...target, collection: pair.target };
      const matchFields = pair.matchFields.trim() ? mongoCompareFields(pair.matchFields) : options.matchFields;
      if (!validMongoMatchFields(matchFields)) throw new MongoCompareError("invalidMatchFields");
      if (leftEndpoint.connectionId === rightEndpoint.connectionId && leftEndpoint.database === rightEndpoint.database && pair.source === pair.target) throw new MongoCompareError("sameEndpoint");
      await requireMongoCompareCollections(api, leftEndpoint, rightEndpoint);
      if (options.signal.aborted) throw new MongoCompareError("cancelled");
      // Wait for both readers even if one fails, so it cannot run behind the next pair.
      const reads = await Promise.allSettled(
        [leftEndpoint, rightEndpoint].map((side, sideIndex) =>
          readMongoCompareSnapshot(api, side, {
            limit: options.limit,
            signal: options.signal,
            executionId: options.executionIds[sideIndex],
          }),
        ),
      );
      const left = reads[0];
      const right = reads[1];
      if (left.status === "rejected") throw left.reason;
      if (right.status === "rejected") throw right.reason;
      if (options.signal.aborted) throw new MongoCompareError("cancelled");
      const result = compareMongoDocuments(left.value.documents, right.value.documents, { ...options, matchFields });
      onUpdate(index, {
        pair,
        state: "complete",
        counts: result.counts,
        truncated: left.value.truncated || right.value.truncated,
        durationMs: Math.round(performance.now() - start),
      });
    } catch (error) {
      onUpdate(index, { pair, state: options.signal.aborted ? "cancelled" : "failed", error });
    }
  }
}
