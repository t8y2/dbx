import { describe, expect, it } from "vitest";
import { AI_TABLE_MENTION_CANDIDATE_LIMIT, aiTableMentionDatabasePlan, aiTableMentionQualifier, filterAiTableMentionCandidates, formatAiTableMention, formatAiTableMentionLabel, normalizeAiTableMentionQuery, parseAiTableMentions, withoutAiTableMentionsOfDatabases } from "@/lib/ai/aiTableMentions";

describe("AI table mention parsing", () => {
  it("parses plain and schema-qualified table mentions", () => {
    expect(parseAiTableMentions("explain @public.users and @orders")).toEqual([
      { raw: "@public.users", schema: "public", table: "users" },
      { raw: "@orders", schema: undefined, table: "orders" },
    ]);
  });

  it("formats quoted table mentions when identifiers need escaping", () => {
    expect(formatAiTableMention("public", "order items")).toBe('@public."order items"');
  });

  // #11660
  it("keeps same-named tables of different selected databases apart", () => {
    expect(parseAiTableMentions("@db_first.public.logs @db_second.public.logs", ["db_first", "db_second"])).toEqual([
      { raw: "@db_first.public.logs", database: "db_first", schema: "public", table: "logs" },
      { raw: "@db_second.public.logs", database: "db_second", schema: "public", table: "logs" },
    ]);
  });

  it("reads the leading segment as a database only when it is selected", () => {
    expect(parseAiTableMentions("@db_second.logs", ["db_second"])).toEqual([{ raw: "@db_second.logs", database: "db_second", schema: undefined, table: "logs" }]);
    expect(parseAiTableMentions("@public.logs", ["db_second"])).toEqual([{ raw: "@public.logs", schema: "public", table: "logs" }]);
  });

  it("formats and labels database-qualified mentions", () => {
    expect(formatAiTableMention("public", "logs", "db_second")).toBe("@db_second.public.logs");
    expect(formatAiTableMention(undefined, "logs", "db_second")).toBe("@db_second.logs");
    expect(formatAiTableMentionLabel("public", "logs", "db_second")).toBe("db_second.public.logs");
    expect(formatAiTableMentionLabel("public", "logs")).toBe("public.logs");
  });
});

describe("AI table mention query", () => {
  it("scopes to a selected database the query names", () => {
    expect(normalizeAiTableMentionQuery("db_second.public.ord", ["db_first", "db_second"])).toEqual({ databasePrefix: "db_second", schemaPrefix: "public", tableFilter: "ord" });
    expect(normalizeAiTableMentionQuery("db_second.ord", ["db_first", "db_second"])).toEqual({ databasePrefix: "db_second", schemaPrefix: "", tableFilter: "ord" });
  });

  it("keeps the schema reading for anything else", () => {
    expect(normalizeAiTableMentionQuery("public.ord", ["db_first"])).toEqual({ schemaPrefix: "public", tableFilter: "ord" });
    expect(normalizeAiTableMentionQuery("ord", ["db_first"])).toEqual({ schemaPrefix: "", tableFilter: "ord" });
  });
});

// #11660: the candidate load has to cover every selected database, and split the
// budget so one large database cannot starve the others.
describe("AI table mention database plan", () => {
  it("searches every selected database", () => {
    expect(aiTableMentionDatabasePlan(["db_first", "db_second"], undefined)).toEqual({ databases: ["db_first", "db_second"], perDatabaseLimit: AI_TABLE_MENTION_CANDIDATE_LIMIT / 2 });
    expect(aiTableMentionDatabasePlan(["only"], undefined)).toEqual({ databases: ["only"], perDatabaseLimit: AI_TABLE_MENTION_CANDIDATE_LIMIT });
  });

  it("scopes to the database the query names, case-insensitively", () => {
    expect(aiTableMentionDatabasePlan(["db_first", "db_second"], "DB_SECOND")).toEqual({ databases: ["db_second"], perDatabaseLimit: AI_TABLE_MENTION_CANDIDATE_LIMIT });
  });

  it("gives every database an equal share of the budget", () => {
    // 200 / 3 rounds up, so the merged list may exceed the cap by two entries and
    // the caller's final filter trims it — a database is never cut to zero.
    expect(aiTableMentionDatabasePlan(["a", "b", "c"], undefined).perDatabaseLimit).toBe(67);
    expect(
      aiTableMentionDatabasePlan(
        Array.from({ length: 300 }, (_, index) => `db_${index}`),
        undefined,
      ).perDatabaseLimit,
    ).toBe(1);
  });
});

describe("AI table mention chip pruning", () => {
  it("drops only the mentions of a deselected database", () => {
    const mentions = [
      { raw: "@db_first.public.logs", database: "db_first", schema: "public", table: "logs" },
      { raw: "@db_second.public.logs", database: "db_second", schema: "public", table: "logs" },
      { raw: "@public.users", schema: "public", table: "users" },
    ];

    expect(withoutAiTableMentionsOfDatabases(mentions, ["db_second"])).toEqual([mentions[0], mentions[2]]);
    expect(withoutAiTableMentionsOfDatabases(mentions, [])).toEqual(mentions);
    // Nothing to drop hands the caller's own array back, so assigning it to the
    // composer ref cannot re-trigger the watchers behind it.
    expect(withoutAiTableMentionsOfDatabases(mentions, [])).toBe(mentions);
  });

  // A chip picked while a single database was selected has a bare label, but it
  // still records which database it came from: deselecting that database has to
  // drop the chip instead of letting it resolve against the database left over.
  it("drops a bare chip as soon as its recorded database leaves the selection", () => {
    const bareChip = { raw: "@public.users", database: "db_first", schema: "public", table: "users" };

    expect(withoutAiTableMentionsOfDatabases([bareChip], ["db_first"])).toEqual([]);
    expect(withoutAiTableMentionsOfDatabases([bareChip], ["db_second"])).toEqual([bareChip]);
  });
});

describe("AI table mention qualifier", () => {
  it("names the database only while several are in play or it is not the primary", () => {
    expect(aiTableMentionQualifier("db_first", "db_first", false)).toBeUndefined();
    expect(aiTableMentionQualifier("DB_FIRST", "db_first", false)).toBeUndefined();
    expect(aiTableMentionQualifier("db_second", "db_first", false)).toBe("db_second");
    expect(aiTableMentionQualifier("db_first", "db_first", true)).toBe("db_first");
    expect(aiTableMentionQualifier(undefined, "db_first", true)).toBeUndefined();
  });
});

describe("AI table mention candidates", () => {
  it("keeps more than the old 20 item cap for a single schema", () => {
    const candidates = tables(40);

    expect(filterAiTableMentionCandidates(candidates, "")).toHaveLength(40);
  });

  it("filters by table name and can return matches after the first 20 entries", () => {
    const candidates = [...tables(25, "order_"), ...tables(30, "audit_")];
    const filtered = filterAiTableMentionCandidates(candidates, "audit_");

    expect(filtered).toHaveLength(30);
    expect(filtered[0].name).toBe("audit_000");
    expect(filtered.at(-1)?.name).toBe("audit_029");
  });

  it("applies the global candidate cap after multi-schema results are merged", () => {
    const merged = [...tables(120, "public_"), ...tables(120, "archive_")];
    const filtered = filterAiTableMentionCandidates(merged, "");

    expect(filtered).toHaveLength(AI_TABLE_MENTION_CANDIDATE_LIMIT);
    expect(filtered[0].name).toBe("public_000");
    expect(filtered.at(-1)?.name).toBe("archive_079");
  });
});

function tables(count: number, prefix = "table_") {
  return Array.from({ length: count }, (_, index) => ({ name: `${prefix}${String(index).padStart(3, "0")}` }));
}
