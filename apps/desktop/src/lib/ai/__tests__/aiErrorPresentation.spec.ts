import { describe, expect, it } from "vitest";
import { aiTestErrorPresentationOf, AI_TEST_ERROR_CATEGORY_KEYS } from "../aiErrorPresentation";

// #15393：报告者反馈「报错信息看不出问题在哪」——错误必须带可行动的分类说明，
// 而不是笼统的失败或未分类。
const translate = (key: string) => `t:${key}`;

describe("aiTestErrorPresentationOf (#15393)", () => {
  it("maps a known category to a localized summary and keeps the raw detail", () => {
    const presentation = aiTestErrorPresentationOf("[auth] invalid api key", translate);
    expect(presentation.summary).toBe(`t:${AI_TEST_ERROR_CATEGORY_KEYS.auth}`);
    expect(presentation.detail).toBe("invalid api key");
  });

  it("explains a gateway 5xx instead of reporting an unknown failure", () => {
    const presentation = aiTestErrorPresentationOf("[serverError] API error (HTTP 500: empty response body)", translate);
    expect(presentation.summary).toBe(`t:${AI_TEST_ERROR_CATEGORY_KEYS.serverError}`);
    expect(presentation.detail).toContain("HTTP 500");
    expect(presentation.summary).not.toBe(`t:${AI_TEST_ERROR_CATEGORY_KEYS.unknown}`);
  });

  it("keeps the whole message as the detail when there is no category", () => {
    const presentation = aiTestErrorPresentationOf("boom: connection refused", translate);
    expect(presentation.summary).toBe("");
    expect(presentation.detail).toBe("boom: connection refused");
  });

  it("keeps the raw message when the category is not one we know", () => {
    const presentation = aiTestErrorPresentationOf("[mystery] something odd", translate);
    expect(presentation.summary).toBe("");
    expect(presentation.detail).toBe("[mystery] something odd");
  });
});
