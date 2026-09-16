import { describe, expect, it } from "vitest";
import { formatMeilisearchTaskDateTime, formatMeilisearchTaskDetails, formatMeilisearchTaskDuration, hasExplicitTaskSelector, meilisearchTaskStatusLabel, normalizeTaskMutationSelector, normalizeTaskSelector, withFixedTaskIndex } from "./meilisearchManagement";

describe("Meilisearch task selector safety", () => {
  it("requires a concrete selector field for batch mutations", () => {
    expect(hasExplicitTaskSelector({})).toBe(false);
    expect(hasExplicitTaskSelector({ statuses: [] })).toBe(false);
    expect(hasExplicitTaskSelector({ indexUids: ["movies"] })).toBe(true);
    expect(hasExplicitTaskSelector({ afterEnqueuedAt: "2026-01-01T00:00:00Z" })).toBe(true);
  });

  it("overrides any caller-provided index with the index-detail constraint", () => {
    expect(withFixedTaskIndex({ indexUids: ["other"], statuses: ["failed"] }, "movies")).toEqual({
      indexUids: ["movies"],
      statuses: ["failed"],
    });
  });

  it("freezes the same normalized status selector enforced by the backend", () => {
    expect(normalizeTaskMutationSelector({ indexUids: [" movies ", "movies"], statuses: ["FAILED", "processing"] }, "cancel")).toEqual({
      indexUids: ["movies"],
      statuses: ["processing"],
    });
    expect(normalizeTaskMutationSelector({ uids: [2] }, "delete")?.statuses).toEqual(["succeeded", "failed", "canceled"]);
    expect(normalizeTaskMutationSelector({ types: ["documentAdditionOrUpdate"], statuses: ["failed"] }, "cancel")).toBeNull();
  });

  it("normalizes task selector values deterministically", () => {
    expect(normalizeTaskSelector({ uids: [3, 1, 3], indexUids: [" books ", ""], statuses: ["FAILED"] })).toEqual({
      uids: [1, 3],
      indexUids: ["books"],
      statuses: ["failed"],
    });
  });

  it("formats task statuses, timestamps, and ISO durations for display", () => {
    expect(meilisearchTaskStatusLabel("succeeded")).toBe("✅ Succeeded");
    expect(meilisearchTaskStatusLabel("processing")).toBe("⚡ Processing");
    expect(meilisearchTaskStatusLabel("futureStatus")).toBe("futureStatus");
    expect(formatMeilisearchTaskDateTime("2026-08-13T16:37:28Z", "en-US")).not.toContain("T16:37:28Z");
    expect(formatMeilisearchTaskDateTime("not-a-date", "en-US")).toBe("not-a-date");
    expect(formatMeilisearchTaskDuration("PT2.16344321S", "en-US")).toBe("2.16 sec");
    expect(formatMeilisearchTaskDuration("PT1H2M3S", "en-US")).toBe("1 hr 2 min");
    expect(formatMeilisearchTaskDuration("unknown", "en-US")).toBe("unknown");
    expect(formatMeilisearchTaskDetails({ receivedDocuments: 8, indexedDocuments: 8, futureField: true }, { receivedDocuments: "接收文档数", indexedDocuments: "已索引文档数" })).toBe("接收文档数: 8 · 已索引文档数: 8 · futureField: true");
    expect(formatMeilisearchTaskDetails(null)).toBe("-");
  });
});
