import { describe, expect, it } from "vitest";
import { formatTaskEndpoint, formatTaskTimestamp, isUnfinishedTaskItem, taskRunElapsedMs, taskRunQueryFromFilters, type TaskRunFilterDraft } from "@/lib/taskHistory";

function draft(overrides: Partial<TaskRunFilterDraft> = {}): TaskRunFilterDraft {
  return { fromDate: "", throughDate: "", sourceQuery: "", targetQuery: "", status: "", ...overrides };
}

function localMidnightIso(year: number, month: number, day: number): string {
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

describe("taskRunQueryFromFilters", () => {
  it("always scopes the query to the transfer task type", () => {
    expect(taskRunQueryFromFilters(draft())).toEqual({ taskType: "transfer" });
  });

  it("converts a single local start date to an inclusive UTC lower bound", () => {
    expect(taskRunQueryFromFilters({ ...draft(), fromDate: "2025-03-05" })).toEqual({
      taskType: "transfer",
      startedAtFrom: localMidnightIso(2025, 3, 5),
    });
  });

  it("converts the through date to an exclusive next-day boundary so the whole local day is included", () => {
    expect(taskRunQueryFromFilters({ ...draft(), throughDate: "2025-03-06" })).toEqual({
      taskType: "transfer",
      startedAtBefore: localMidnightIso(2025, 3, 7),
    });
  });

  it("keeps a range spanning a daylight-saving transition on local calendar days", () => {
    const query = taskRunQueryFromFilters({ ...draft(), fromDate: "2025-03-30", throughDate: "2025-03-30" });
    expect(query.startedAtFrom).toBe(localMidnightIso(2025, 3, 30));
    expect(query.startedAtBefore).toBe(localMidnightIso(2025, 3, 31));
    expect(new Date(query.startedAtBefore!).getTime()).toBeGreaterThan(new Date(query.startedAtFrom!).getTime());
  });

  it("drops calendar dates that do not exist instead of shifting them", () => {
    const query = taskRunQueryFromFilters({ ...draft(), fromDate: "2025-02-30", throughDate: "2025-13-01" });
    expect(query).toEqual({ taskType: "transfer" });
  });

  it("ignores malformed date input", () => {
    expect(taskRunQueryFromFilters({ ...draft(), fromDate: "2025/03/05", throughDate: "yesterday" })).toEqual({ taskType: "transfer" });
  });

  it("trims endpoint searches and drops empty ones", () => {
    expect(taskRunQueryFromFilters({ ...draft(), sourceQuery: "  app_users  ", targetQuery: "   " })).toEqual({
      taskType: "transfer",
      sourceQuery: "app_users",
    });
  });

  it("passes the selected status through and keeps role-free endpoint text literal", () => {
    expect(taskRunQueryFromFilters({ ...draft(), sourceQuery: "a%b_c", status: "partial_failed" })).toEqual({
      taskType: "transfer",
      sourceQuery: "a%b_c",
      status: "partial_failed",
    });
  });
});

describe("formatTaskEndpoint", () => {
  it("joins the saved database type, catalog, database, and schema", () => {
    expect(formatTaskEndpoint({ connectionId: "c1", databaseType: "mysql", catalog: "cat", database: "shop", schema: "s1" })).toBe("mysql · cat · shop · s1");
  });

  it("skips missing parts without leaving separators behind", () => {
    expect(formatTaskEndpoint({ connectionId: "c1", databaseType: "postgres", catalog: null, database: "app", schema: "" })).toBe("postgres · app");
  });
});

describe("formatTaskTimestamp", () => {
  it("returns an empty string for a missing value", () => {
    expect(formatTaskTimestamp(null, "en")).toBe("");
    expect(formatTaskTimestamp(undefined, "en")).toBe("");
  });

  it("keeps an unparsable stored timestamp visible instead of rendering Invalid Date", () => {
    expect(formatTaskTimestamp("not-a-timestamp", "en")).toBe("not-a-timestamp");
  });

  it("formats a stored timestamp with the active locale", () => {
    const en = formatTaskTimestamp("2025-03-05T10:20:30.000Z", "en");
    const zh = formatTaskTimestamp("2025-03-05T10:20:30.000Z", "zh-CN");
    expect(en).not.toBe("");
    expect(zh).not.toBe("");
    expect(en).not.toContain("Invalid");
    expect(zh).not.toContain("Invalid");
  });
});

describe("taskRunElapsedMs", () => {
  it("measures the persisted duration", () => {
    expect(taskRunElapsedMs("2025-03-05T10:00:00.000Z", "2025-03-05T10:00:02.500Z")).toBe(2500);
  });

  it("has no duration while a run is unfinished", () => {
    expect(taskRunElapsedMs("2025-03-05T10:00:00.000Z", null)).toBeNull();
    expect(taskRunElapsedMs("2025-03-05T10:00:00.000Z", undefined)).toBeNull();
  });

  it("refuses to invent a negative or invalid duration", () => {
    expect(taskRunElapsedMs("2025-03-05T10:00:05.000Z", "2025-03-05T10:00:00.000Z")).toBeNull();
    expect(taskRunElapsedMs("broken", "2025-03-05T10:00:00.000Z")).toBeNull();
  });
});

describe("isUnfinishedTaskItem", () => {
  it("treats only a succeeded object as finished", () => {
    expect(isUnfinishedTaskItem("succeeded")).toBe(false);
    for (const status of ["pending", "running", "skipped", "failed", "cancelled", "not_started", "incomplete"] as const) {
      expect(isUnfinishedTaskItem(status)).toBe(true);
    }
  });
});
