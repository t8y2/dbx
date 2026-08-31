import { describe, expect, it } from "vitest";
import { externalSqlFileContentMatchesBaseline, externalSqlFileMetadataMatches, externalSqlFileVersionWasIgnored } from "@/lib/sql/externalSqlFileChanges";
import type { ExternalSqlFileSnapshot } from "@/lib/backend/tauri";
import type { QueryTab } from "@/types/database";

const originalVersion = {
  sizeBytes: 9,
  modifiedNs: "100",
  contentHash: "original",
};

const changedSnapshot: ExternalSqlFileSnapshot = {
  content: "select 2;",
  version: {
    sizeBytes: 9,
    modifiedNs: "200",
    contentHash: "changed",
  },
};

function tab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "tab-1",
    title: "demo.sql",
    connectionId: "",
    database: "",
    sql: "select 1;",
    originalSql: "select 1;",
    externalSqlPath: "/tmp/demo.sql",
    externalSqlFileVersion: originalVersion,
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
    mode: "query",
    ...overrides,
  };
}

describe("external SQL file change detection", () => {
  it("uses size and precise modification time for the metadata fast path", () => {
    expect(externalSqlFileMetadataMatches(originalVersion, { kind: "present", sizeBytes: 9, modifiedNs: "100" })).toBe(true);
    expect(externalSqlFileMetadataMatches(originalVersion, { kind: "present", sizeBytes: 9, modifiedNs: "101" })).toBe(false);
    expect(externalSqlFileMetadataMatches(originalVersion, { kind: "missing" })).toBe(false);
  });

  it("treats identical raw content or identical decoded baseline text as unchanged", () => {
    expect(externalSqlFileContentMatchesBaseline(tab(), { ...changedSnapshot, content: "select 1;" })).toBe(true);
    expect(externalSqlFileContentMatchesBaseline(tab(), { ...changedSnapshot, version: originalVersion })).toBe(true);
    expect(externalSqlFileContentMatchesBaseline(tab(), changedSnapshot)).toBe(false);
  });

  it("suppresses only the exact external version the user kept", () => {
    expect(externalSqlFileVersionWasIgnored(tab({ externalSqlIgnoredFileVersion: changedSnapshot.version }), changedSnapshot)).toBe(true);
    expect(externalSqlFileVersionWasIgnored(tab({ externalSqlIgnoredFileVersion: originalVersion }), changedSnapshot)).toBe(false);
  });
});
