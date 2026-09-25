import { describe, expect, it } from "vitest";

import { formatRedisMemberDetail, normalizeRedisJsonDraft } from "@/lib/redis/redisValuePresentation";

/** Owner-review fixture: compact save must not drop the second "role" member. */
const DUPLICATE_MEMBER_COMPACT = '{"role":"reader","role":"writer"}';
const DUPLICATE_MEMBER_PRETTY = `{
  "role": "reader",
  "role": "writer"
}`;

describe("native RedisJSON editor", () => {
  it("string JSON editor open+save keeps duplicate members end-to-end", () => {
    // Open: string JSON view pretty baseline comes from formatRedisMemberDetail.
    const opened = formatRedisMemberDetail(DUPLICATE_MEMBER_COMPACT, { allowJsonText: true });
    expect(opened.json?.formattedText).toBe(DUPLICATE_MEMBER_PRETTY);

    // Save: saveString always compact-writes through normalizeRedisJsonDraft.
    const saved = normalizeRedisJsonDraft(opened.json!.formattedText);
    expect(saved).toEqual({ ok: true, compactText: DUPLICATE_MEMBER_COMPACT });
  });

  it("hash JSON editor open+save keeps duplicate members end-to-end", () => {
    // Open: hash field JSON view uses the same detail pretty baseline.
    const opened = formatRedisMemberDetail(DUPLICATE_MEMBER_COMPACT, { allowJsonText: true });
    expect(opened.json?.formattedText).toBe(DUPLICATE_MEMBER_PRETTY);

    // Save: saveMemberEdit compact-writes hash JSON drafts through the same helper.
    const saved = normalizeRedisJsonDraft(opened.json!.formattedText);
    expect(saved).toEqual({ ok: true, compactText: DUPLICATE_MEMBER_COMPACT });
  });
});
