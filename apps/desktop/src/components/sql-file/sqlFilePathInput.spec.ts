import { describe, expect, it } from "vitest";
import { parseSqlFilePathInput } from "./sqlFilePathInput";

describe("parseSqlFilePathInput", () => {
  it("returns a single trimmed path", () => {
    expect(parseSqlFilePathInput("  /tmp/a.sql  ")).toEqual(["/tmp/a.sql"]);
  });

  it("strips quotes added by Windows Copy as path", () => {
    expect(parseSqlFilePathInput('"C:\\Users\\me\\my dump.sql"')).toEqual(["C:\\Users\\me\\my dump.sql"]);
  });

  it("splits on semicolons and newlines and drops blanks", () => {
    expect(parseSqlFilePathInput("/a.sql; /b.sql\r\n/c.sql;\n\n")).toEqual(["/a.sql", "/b.sql", "/c.sql"]);
  });

  it("returns an empty list for blank input", () => {
    expect(parseSqlFilePathInput("  ;  \n ")).toEqual([]);
  });
});
