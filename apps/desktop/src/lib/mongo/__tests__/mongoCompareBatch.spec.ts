import { describe, expect, it, vi } from "vitest";
import { compareMongoBatch, matchMongoCollections, requireMongoCompareCollections, type MongoBatchSummary, type MongoCollectionPair } from "../mongoCompareBatch";

const source = { connectionId: "source", database: "db", collection: "a", filter: "{}" };
const target = { ...source, connectionId: "target" };
const pair = (name: string): MongoCollectionPair => ({ source: name, target: name, enabled: true, matchFields: "" });
const page = (docs: object[]) => ({ documents: docs, extended_documents: docs });
const options = () => ({
  matchFields: ["_id"],
  ignoredFields: [],
  limit: 100,
  signal: new AbortController().signal,
  executionIds: ["source-read", "target-read"] as [string, string],
});
const api = () => ({
  mongoListCollections: vi.fn(async () => [{ name: "a" }, { name: "b" }]),
  mongoFindDocuments: vi.fn(async (id: string, _db: string, _col: string, skip: number) => page(skip ? [] : [{ _id: 1, value: id }])),
  mongoRunCommand: vi.fn(),
});

describe("Mongo collection batch comparison", () => {
  it("adds only unused identical names and preserves custom pair settings", () => {
    const manual = { ...pair("a"), target: "archive", matchFields: "key", enabled: false };
    expect(matchMongoCollections(["a", "b", "only-left"], ["a", "b", "archive"], [manual])).toEqual([manual, pair("b")]);
  });

  it("compares pairs sequentially and returns only statistics without writing", async () => {
    const backend = api();
    const completed: MongoBatchSummary[] = [];
    await compareMongoBatch(backend, source, target, [pair("a"), pair("b")], options(), (_index, summary) => completed.push(summary));
    expect(completed.map((item) => item.state)).toEqual(["running", "complete", "running", "complete"]);
    expect(completed[1]).toMatchObject({ counts: { different: 1 }, truncated: false });
    expect(JSON.stringify(completed)).not.toContain('"value"');
    expect(backend.mongoRunCommand).not.toHaveBeenCalled();
  });

  it("rejects a missing collection instead of treating it as empty, then continues other pairs", async () => {
    const backend = api();
    backend.mongoListCollections.mockImplementation(async (id?: string) => (id === "target" ? [{ name: "b" }] : [{ name: "a" }, { name: "b" }]));
    const summaries: MongoBatchSummary[] = [];
    await compareMongoBatch(backend, source, target, [pair("a"), pair("b")], options(), (index, summary) => {
      summaries[index] = summary;
    });
    expect(summaries.map((item) => item.state)).toEqual(["failed", "complete"]);
    expect(summaries[0].error).toMatchObject({ code: "collectionMissing" });
    expect(backend.mongoFindDocuments.mock.calls.every((call) => call[2] === "b")).toBe(true);
    await expect(requireMongoCompareCollections(backend, source, target)).rejects.toMatchObject({ code: "collectionMissing" });
  });

  it("respects per-pair keys and reports truncated reads explicitly", async () => {
    const backend = api();
    backend.mongoFindDocuments.mockImplementation(async (id, _db, _col, skip) =>
      page(
        skip
          ? []
          : [
              { _id: id, key: "same", value: 1 },
              { _id: `${id}2`, key: "other" },
            ],
      ),
    );
    let result: MongoBatchSummary | undefined;
    await compareMongoBatch(backend, source, target, [{ ...pair("a"), matchFields: "key" }], { ...options(), limit: 1, ignoredFields: ["_id"] }, (_index, summary) => {
      result = summary;
    });
    expect(result).toMatchObject({ state: "complete", truncated: true, counts: { same: 1, sourceOnly: 0, targetOnly: 0 } });
  });

  it("cancels remaining pairs and performs no later reads", async () => {
    const backend = api();
    const controller = new AbortController();
    const summaries: MongoBatchSummary[] = [];
    await compareMongoBatch(backend, source, target, [pair("a"), pair("b")], { ...options(), signal: controller.signal }, (index, summary) => {
      summaries[index] = summary;
      if (index === 0 && summary.state === "complete") controller.abort();
    });
    expect(summaries.map((item) => item.state)).toEqual(["complete", "cancelled"]);
    expect(backend.mongoFindDocuments.mock.calls.every((call) => call[2] === "a")).toBe(true);
  });

  it("waits for the other reader after a failure before starting the next pair", async () => {
    const backend = api();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.mongoFindDocuments.mockImplementation(async (id, _db, collection, skip) => {
      if (collection === "a" && id === "source") throw new Error("Read failed");
      if (collection === "a") await pending;
      return page(skip ? [] : [{ _id: 1 }]);
    });
    const running = compareMongoBatch(backend, source, target, [pair("a"), pair("b")], options(), () => {});
    await vi.waitFor(() => expect(backend.mongoFindDocuments).toHaveBeenCalledTimes(2));
    expect(backend.mongoFindDocuments.mock.calls.some((call) => call[2] === "b")).toBe(false);
    release();
    await running;
    expect(backend.mongoFindDocuments.mock.calls.some((call) => call[2] === "b")).toBe(true);
  });
});
