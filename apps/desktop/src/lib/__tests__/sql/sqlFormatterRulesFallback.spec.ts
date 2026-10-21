import { describe, expect, it, vi } from "vitest";

// Simulate the external package moving its private parser, not our own layout behavior.
vi.mock("sql-formatter/dist/esm/parser/createParser.js", () => {
  throw new Error("External parser module unavailable");
});

import { formatSqlText } from "@/lib/sql/sqlFormatter";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";

describe("custom rule engine recovery", () => {
  it("keeps the public formatter usable and reports the downgrade once", async () => {
    const source = "select a,b from t where id=1;";
    const base = await formatSqlText(source, "oracle", { layoutStyle: "classic" });
    const diagnostics: string[] = [];
    const result = await formatSqlText(source, "oracle", { customRulesEnabled: true, selectListLayout: "singleLine", layoutStyle: "classic" }, (diagnostic) => diagnostics.push(diagnostic));
    expect(result).toBe(base);
    expect(diagnostics).toEqual(["custom-rules-fallback"]);
  });

  it.each(["remove", "single"] as const)("restores original input and base spacing after the engine declines %s rules", async (emptyLineMode) => {
    const source = "-- heading\n\nselect a,b from t; select 2;";
    const saved = { layoutStyle: "classic", preserveEmptyLines: true, linesBetweenQueries: 2 } as const;
    const base = await formatSqlText(source, "oracle", saved);
    const diagnostics: string[] = [];
    const result = await formatSqlText(source, "oracle", { ...saved, customRulesEnabled: true, emptyLineMode }, (value) => diagnostics.push(value));
    expect(result).toBe(base);
    expect(diagnostics).toEqual(["custom-rules-fallback"]);
  });

  it("preserves multiline q literals and line comment boundaries when the private engine is unavailable", async () => {
    const literal = "q'[first 'quoted'\r\n  \t\r\nlast]'";
    const comment = "/* first\r\n\r\nlast */";
    const source = `select ${literal} as note ${comment} from dual where x=1 -- note\nand y=2;`;
    const saved = { layoutStyle: "classic", preserveEmptyLines: true, logicalOperatorNewline: "none" } as const;
    const diagnostics: string[] = [];
    const result = await formatSqlText(source, "oracle", { ...saved, customRulesEnabled: true }, (value) => diagnostics.push(value));
    expect(result).toContain(literal);
    expect(result).toContain(comment);
    expect(result).toMatch(/-- note\n\s*AND y = 2/);
    expect(tokenizeSqlSemantic(result, "oracle").map((token) => token.normalized)).toEqual(tokenizeSqlSemantic(source, "oracle").map((token) => token.normalized));
    expect(result).toBe(await formatSqlText(source, "oracle", saved));
    expect(await formatSqlText(result, "oracle", { ...saved, customRulesEnabled: true })).toBe(result);
    expect(diagnostics).toEqual(["custom-rules-fallback"]);
  });
});
