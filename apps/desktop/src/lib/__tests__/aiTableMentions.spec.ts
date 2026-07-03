import { describe, expect, it } from "vitest";
import { AI_TABLE_MENTION_CANDIDATE_LIMIT, filterAiTableMentionCandidates, formatAiTableMention, parseAiTableMentions } from "@/lib/aiTableMentions";

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
