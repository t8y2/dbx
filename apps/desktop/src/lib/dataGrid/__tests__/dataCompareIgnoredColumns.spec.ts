import { describe, expect, it } from "vitest";
import { auditColumnCandidates, ignoredColumnsWithoutMatch, resolveEffectiveIgnoredColumns } from "../dataCompare";

describe("resolveEffectiveIgnoredColumns", () => {
  it("merges the global list with the table additions in compared-column order", () => {
    expect(
      resolveEffectiveIgnoredColumns({
        globalIgnoredColumns: ["updated_at", "created_by"],
        tableIgnoredColumns: ["version"],
        columns: ["id", "version", "name", "created_by", "updated_at"],
        keyColumns: ["id"],
      }),
    ).toEqual(["version", "created_by", "updated_at"]);
  });

  it("matches names case-insensitively and drops names that are no compared column", () => {
    expect(
      resolveEffectiveIgnoredColumns({
        globalIgnoredColumns: ["UPDATED_AT", "nope"],
        columns: ["id", "Updated_At"],
        keyColumns: ["id"],
      }),
    ).toEqual(["Updated_At"]);
  });

  it("never ignores a match column, even when it is requested", () => {
    expect(
      resolveEffectiveIgnoredColumns({
        globalIgnoredColumns: ["id", "updated_at"],
        columns: ["id", "updated_at"],
        keyColumns: ["id"],
      }),
    ).toEqual(["updated_at"]);
  });

  it("returns an empty list without any request", () => {
    expect(resolveEffectiveIgnoredColumns({ globalIgnoredColumns: [], columns: ["id"], keyColumns: ["id"] })).toEqual([]);
  });
});

describe("auditColumnCandidates", () => {
  it("picks columns whose names contain create or update, case-insensitively", () => {
    // "creative_title" merely contains "creati", not the fragment "create".
    expect(auditColumnCandidates(["id", "created_at", "UPDATED_BY", "gmt_create", "updater", "name", "creative_title"])).toEqual(["created_at", "UPDATED_BY", "gmt_create", "updater"]);
  });

  it("returns nothing when no audit-style column exists", () => {
    expect(auditColumnCandidates(["id", "amount", "status"])).toEqual([]);
  });
});

describe("ignoredColumnsWithoutMatch", () => {
  it("reports a name that matches no compared table", () => {
    expect(
      ignoredColumnsWithoutMatch(
        ["updated_at", "gmt_modified"],
        [
          ["id", "updated_at"],
          ["id", "UPDATED_AT"],
        ],
      ),
    ).toEqual(["gmt_modified"]);
  });

  it("stays silent when a name exists in at least one table", () => {
    expect(
      ignoredColumnsWithoutMatch(
        ["created_at"],
        [
          ["id", "name"],
          ["id", "name", "created_at"],
        ],
      ),
    ).toEqual([]);
  });
});
