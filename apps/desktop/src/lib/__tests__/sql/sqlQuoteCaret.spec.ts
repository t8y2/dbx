import { describe, expect, it } from "vitest";
import { resolveSqlSingleQuoteKeyAction } from "@/lib/sql/sqlQuoteCaret";

describe("resolveSqlSingleQuoteKeyAction", () => {
  it("skips over the auto-inserted closing single quote", () => {
    expect(resolveSqlSingleQuoteKeyAction({ previousChar: "'", nextChar: "'" })).toBe("skipClosingQuote");
  });

  it("keeps escaped quote insertion when there is no closing quote to skip", () => {
    expect(resolveSqlSingleQuoteKeyAction({ previousChar: "'", nextChar: "" })).toBe("insertEscapedQuote");
  });

  it("lets CodeMirror handle ordinary single quote input", () => {
    expect(resolveSqlSingleQuoteKeyAction({ previousChar: "a", nextChar: "" })).toBe("pass");
  });

  it("does not skip an existing string opening quote after whitespace", () => {
    expect(resolveSqlSingleQuoteKeyAction({ previousChar: " ", nextChar: "'" })).toBe("pass");
  });

  it("does not skip an existing string opening quote at the start of the document", () => {
    expect(resolveSqlSingleQuoteKeyAction({ previousChar: "", nextChar: "'" })).toBe("pass");
  });

  it("does not intercept input when auto-close brackets is disabled", () => {
    expect(resolveSqlSingleQuoteKeyAction({ previousChar: "'", nextChar: "'", autoCloseBrackets: false })).toBe("pass");
  });
});
