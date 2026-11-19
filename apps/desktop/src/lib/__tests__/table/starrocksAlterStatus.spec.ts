import { describe, expect, it } from "vitest";
import { isStarRocksAlterJobActive, parseStarRocksAlterJobs, recentStarRocksAlterJobs, starRocksAlterStatusSql } from "@/lib/table/starrocksAlterStatus";
describe("StarRocks ALTER status", () => {
  it("quotes table literals and rejects SQL-mode-sensitive names", () => {
    expect(starRocksAlterStatusSql("COLUMN", "a'b")).toContain("TableName = 'a''b'");
    expect(() => starRocksAlterStatusSql("COLUMN", "a\\b")).toThrow();
    expect(() => starRocksAlterStatusSql("COLUMN", "a\0b")).toThrow();
  });
  it("maps by column name, supports rollup finish spelling and real progress", () => {
    const jobs = parseStarRocksAlterJobs("ROLLUP", {
      columns: ["State", "JobId", "Progress", "FinishedTime", "Msg"],
      rows: [
        ["RUNNING", 12, "2/8", null, ""],
        ["CANCELLED", 13, "N/A", "2026-01-01", "reason"],
      ],
    });
    expect(jobs[0].progress).toBe(25);
    expect(jobs[1].progress).toBeUndefined();
    expect(jobs[1].finished).toBe("2026-01-01");
    expect(jobs[1].message).toBe("reason");
    expect(isStarRocksAlterJobActive(jobs[0])).toBe(true);
    expect(isStarRocksAlterJobActive(jobs[1])).toBe(false);
  });
  it("does not treat unknown states or malformed result shapes as completed", () => {
    const [job] = parseStarRocksAlterJobs("COLUMN", { columns: ["JobId", "State", "Progress"], rows: [[1, "FUTURE_STATE", "150%"]] });
    expect(isStarRocksAlterJobActive(job)).toBe(true);
    expect(job.progress).toBeUndefined();
    expect(() => parseStarRocksAlterJobs("COLUMN", { columns: ["error"], rows: [] })).toThrow();
  });
  it("combines the latest five across kinds", () => {
    const jobs = parseStarRocksAlterJobs("COLUMN", { columns: ["JobId", "State", "CreateTime"], rows: Array.from({ length: 8 }, (_, i) => [i, "FINISHED", `2026-01-0${i + 1}`]) });
    expect(recentStarRocksAlterJobs(jobs).map((job) => job.id)).toEqual(["7", "6", "5", "4", "3"]);
  });
});
