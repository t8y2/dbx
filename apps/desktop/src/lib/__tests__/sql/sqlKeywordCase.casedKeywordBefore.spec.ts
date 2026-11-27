import { beforeAll, describe, expect, it } from "vitest";
import { loadEngine } from "@/lib/sql/layout/internals";
import { casedKeywordBefore } from "@/lib/sql/sqlKeywordCase";

beforeAll(async () => {
  // The classifier is synchronous by design; typing-path callers only get a
  // result once the formatter engine has been imported.
  await loadEngine();
});

describe("casedKeywordBefore", () => {
  it("re-cases the keyword that ends the text", () => {
    expect(casedKeywordBefore("select", "mysql", "upper")).toEqual({ from: 0, to: 6, insert: "SELECT" });
    expect(casedKeywordBefore("SELECT a FROM", "mysql", "lower")).toEqual({ from: 9, to: 13, insert: "from" });
  });

  it("reports the range of the word only, for the caller to dispatch", () => {
    expect(casedKeywordBefore("select a from t where", "postgres", "upper")).toEqual({ from: 16, to: 21, insert: "WHERE" });
  });

  it("returns null when the trailing word already has the requested case", () => {
    expect(casedKeywordBefore("SELECT", "mysql", "upper")).toBeNull();
    expect(casedKeywordBefore("select", "mysql", "lower")).toBeNull();
  });

  it("leaves ordinary identifiers alone", () => {
    expect(casedKeywordBefore("select mycol", "mysql", "upper")).toBeNull();
    expect(casedKeywordBefore("select sel", "mysql", "upper")).toBeNull();
  });

  it("does not touch function names or data types", () => {
    // Same contract as the toolbar toggle: those follow functionCase/dataTypeCase.
    expect(casedKeywordBefore("select count", "mysql", "upper")).toBeNull();
    expect(casedKeywordBefore("select cast(a as int", "mysql", "upper")).toBeNull();
  });

  it("re-cases only the last word of a multi-word clause", () => {
    // The earlier words were converted when their own boundary was typed.
    const text = "select a from t group by";
    const replacement = casedKeywordBefore(text, "mysql", "upper");
    expect(replacement).toEqual({ from: text.length - 2, to: text.length, insert: "BY" });
  });

  it("declines input the lexer rejects instead of guessing", () => {
    // An unclosed string literal is a normal mid-typing state.
    expect(casedKeywordBefore("select 'unclosed from", "postgres", "upper")).toBeNull();
  });

  it("returns null for a dialect with no SQL grammar", () => {
    expect(casedKeywordBefore("select", "cypher", "upper")).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(casedKeywordBefore("", "mysql", "upper")).toBeNull();
  });
});
