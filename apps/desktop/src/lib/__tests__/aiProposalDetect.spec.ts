import { describe, expect, it } from "vitest";
import { containsChinese, isShortAffirmative, isShortNegative, looksLikeActionProposal } from "@/lib/aiProposalDetect";

describe("looksLikeActionProposal", () => {
  // ---- zh-CN proposals ----
  it("detects zh proposal: 需要我执行这个查询吗？", () => {
    expect(looksLikeActionProposal("需要我执行这个查询吗？")).toBe(true);
  });

  it("detects zh proposal: 要不要我拉取这两个表的数据？", () => {
    expect(looksLikeActionProposal("要不要我拉取这两个表的数据？")).toBe(true);
  });

  it("detects zh proposal: 是否需要我帮你查一下订单表？", () => {
    expect(looksLikeActionProposal("是否需要我帮你查一下订单表？")).toBe(true);
  });

  it("detects zh proposal: 我来执行这个 SQL？", () => {
    expect(looksLikeActionProposal("我来执行这个 SQL？")).toBe(true);
  });

  it("detects zh proposal in last line of multi-line message", () => {
    const multi = "我已经查看了 orders 表的结构。\n现在需要我查看一下 users 表吗？";
    expect(looksLikeActionProposal(multi)).toBe(true);
  });

  it("detects zh proposal: 我去看看这两个表的数据？", () => {
    expect(looksLikeActionProposal("需要我去看看这两个表的数据？")).toBe(true);
  });

  // ---- en proposals ----
  it("detects en proposal: Should I execute this query?", () => {
    expect(looksLikeActionProposal("Should I execute this query?")).toBe(true);
  });

  it("detects en proposal: Do you want me to fetch the data?", () => {
    expect(looksLikeActionProposal("Do you want me to fetch the data?")).toBe(true);
  });

  it("detects en proposal: Shall I run the analysis?", () => {
    expect(looksLikeActionProposal("Shall I run the analysis?")).toBe(true);
  });

  it("detects en proposal: Can I pull the sample data?", () => {
    expect(looksLikeActionProposal("Can I pull the sample data?")).toBe(true);
  });

  // ---- negative cases (NOT proposals) ----
  it("rejects generic clarifying question without action", () => {
    expect(looksLikeActionProposal("请问 orders 表有哪些字段？")).toBe(false);
  });

  it("rejects zh question without ask phrase", () => {
    expect(looksLikeActionProposal("这个查询的执行结果正确吗？")).toBe(false);
  });

  it("rejects en question without ask phrase", () => {
    expect(looksLikeActionProposal("What columns does the orders table have?")).toBe(false);
  });

  it("rejects statement ending with period", () => {
    expect(looksLikeActionProposal("需要我执行这个查询。")).toBe(false);
  });

  it("rejects empty content", () => {
    expect(looksLikeActionProposal("")).toBe(false);
  });

  it("rejects en question with no actionable verb", () => {
    expect(looksLikeActionProposal("Should I proceed?")).toBe(false);
  });

  it("rejects zh proposal ending with period", () => {
    expect(looksLikeActionProposal("需要我查看订单表的数据。")).toBe(false);
  });

  it("rejects message with no question mark", () => {
    expect(looksLikeActionProposal("需要我执行查询")).toBe(false);
  });

  it("rejects mixed punctuation but not a question", () => {
    expect(looksLikeActionProposal("可以了，谢谢！")).toBe(false);
  });
});

describe("isShortAffirmative", () => {
  // zh
  it("matches 需要", () => expect(isShortAffirmative("需要")).toBe(true));
  it("matches 好", () => expect(isShortAffirmative("好")).toBe(true));
  it("matches 好的", () => expect(isShortAffirmative("好的")).toBe(true));
  it("matches 可以", () => expect(isShortAffirmative("可以")).toBe(true));
  it("matches 是", () => expect(isShortAffirmative("是")).toBe(true));
  it("matches 对", () => expect(isShortAffirmative("对")).toBe(true));
  it("matches 嗯", () => expect(isShortAffirmative("嗯")).toBe(true));

  // zh with punctuation
  it("strips punctuation: 好！", () => expect(isShortAffirmative("好！")).toBe(true));
  it("strips punctuation: 好的。", () => expect(isShortAffirmative("好的。")).toBe(true));

  // en
  it("matches yes", () => expect(isShortAffirmative("yes")).toBe(true));
  it("matches Yes (capitalized)", () => expect(isShortAffirmative("Yes")).toBe(true));
  it("matches ok", () => expect(isShortAffirmative("ok")).toBe(true));
  it("matches OK", () => expect(isShortAffirmative("OK")).toBe(true));
  it("matches sure", () => expect(isShortAffirmative("sure")).toBe(true));
  it("matches go ahead", () => expect(isShortAffirmative("go ahead")).toBe(true));
  it("matches do it", () => expect(isShortAffirmative("do it")).toBe(true));
  it("matches proceed", () => expect(isShortAffirmative("proceed")).toBe(true));

  // negative
  it("rejects long message", () => expect(isShortAffirmative("好的，我来看看具体情况")).toBe(false));
  it("rejects unrelated word", () => expect(isShortAffirmative("其他")).toBe(false));
  it("rejects empty", () => expect(isShortAffirmative("")).toBe(false));
});

describe("isShortNegative", () => {
  // zh
  it("matches 不用", () => expect(isShortNegative("不用")).toBe(true));
  it("matches 不用了", () => expect(isShortNegative("不用了")).toBe(true));
  it("matches 不需要", () => expect(isShortNegative("不需要")).toBe(true));
  it("matches 不要", () => expect(isShortNegative("不要")).toBe(true));
  it("matches 先不", () => expect(isShortNegative("先不")).toBe(true));

  // zh with punctuation
  it("strips punctuation: 不用了。", () => expect(isShortNegative("不用了。")).toBe(true));

  // en
  it("matches no", () => expect(isShortNegative("no")).toBe(true));
  it("matches nope", () => expect(isShortNegative("nope")).toBe(true));
  it("matches not needed", () => expect(isShortNegative("not needed")).toBe(true));
  it("matches don't", () => expect(isShortNegative("don't")).toBe(true));
  it("matches cancel", () => expect(isShortNegative("cancel")).toBe(true));

  // negative
  it("rejects long message", () => expect(isShortNegative("不用了，谢谢，我自己来查")).toBe(false));
  it("rejects empty", () => expect(isShortNegative("")).toBe(false));
});

describe("containsChinese", () => {
  it("detects Chinese characters", () => expect(containsChinese("需要我执行")).toBe(true));
  it("rejects pure ASCII", () => expect(containsChinese("Should I execute")).toBe(false));
  it("handles mixed CJK punctuation-only", () => expect(containsChinese("？。，")).toBe(false));
});
