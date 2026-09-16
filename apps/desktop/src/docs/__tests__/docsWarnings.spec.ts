import { describe, expect, it } from "vitest";
import { describeWarning, type Translate } from "../docsWarnings";
import type { SnapshotWarning } from "../types";

// A fake translator that echoes the key and params back rather than English
// prose. This is what actually matters now: that describeWarning calls
// translate with the right key and the right params, not what the English
// copy says — the copy itself lives in the i18n namespace and is covered by
// the parity test.
const translate: Translate = (key, params) => `${key}|${JSON.stringify(params ?? {})}`;

describe("describeWarning", () => {
  it("explains a skipped table as a warning naming the table and reason", () => {
    const notice = describeWarning({ kind: "tableSkipped", table: "public.secret", reason: "permission denied" }, translate);
    expect(notice.severity).toBe("warning");
    expect(notice.title).toBe("docs.warnings.tableSkipped.title|{}");
    expect(notice.detail).toBe('docs.warnings.tableSkipped.detail|{"table":"public.secret","reason":"permission denied"}');
  });

  it("explains missing foreign-key metadata as an engine limitation, not a fault", () => {
    const notice = describeWarning({ kind: "noForeignKeyMetadata", engine: "ClickHouse" }, translate);
    expect(notice.severity).toBe("info");
    expect(notice.title).toBe("docs.warnings.noForeignKeyMetadata.title|{}");
    expect(notice.detail).toBe('docs.warnings.noForeignKeyMetadata.detail|{"engine":"ClickHouse"}');
  });

  it("explains unsupported comments", () => {
    const notice = describeWarning({ kind: "commentsUnsupported", engine: "SQLite" }, translate);
    expect(notice.severity).toBe("info");
    expect(notice.title).toBe("docs.warnings.commentsUnsupported.title|{}");
    expect(notice.detail).toBe('docs.warnings.commentsUnsupported.detail|{"engine":"SQLite"}');
  });

  it("reports orphaned notes with the count", () => {
    const notice = describeWarning({ kind: "orphanedNotes", count: 3 }, translate);
    expect(notice.severity).toBe("warning");
    expect(notice.title).toBe("docs.warnings.orphanedNotes.title|{}");
    expect(notice.detail).toBe('docs.warnings.orphanedNotes.detail|{"count":3}');
  });

  it("explains a DBML omission naming the item", () => {
    const notice = describeWarning(
      {
        kind: "dbmlOmitted",
        table: "public.orders",
        item: "idx_orders_open",
        reason: "partial index filter has no DBML equivalent",
      },
      translate,
    );
    expect(notice.severity).toBe("info");
    expect(notice.title).toBe("docs.warnings.dbmlOmitted.title|{}");
    expect(notice.detail).toBe('docs.warnings.dbmlOmitted.detail|{"item":"idx_orders_open","table":"public.orders","reason":"partial index filter has no DBML equivalent"}');
  });

  it("never returns an empty title or detail for any known kind", () => {
    const samples: SnapshotWarning[] = [
      { kind: "tableSkipped", table: "t", reason: "r" },
      { kind: "noForeignKeyMetadata", engine: "e" },
      { kind: "commentsUnsupported", engine: "e" },
      { kind: "orphanedNotes", count: 1 },
      { kind: "dbmlOmitted", table: "t", item: "i", reason: "r" },
    ];
    for (const sample of samples) {
      const notice = describeWarning(sample, translate);
      expect(notice.title.length, `empty title for ${sample.kind}`).toBeGreaterThan(0);
      expect(notice.detail.length, `empty detail for ${sample.kind}`).toBeGreaterThan(0);
    }
  });
});
