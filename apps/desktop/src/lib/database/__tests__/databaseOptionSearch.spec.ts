import { describe, expect, it } from "vitest";
import { filterDatabaseOptions } from "../databaseOptionSearch";

describe("filterDatabaseOptions", () => {
  it("returns original options when query is empty or whitespace", () => {
    const options = ["tinyint", "int", "bigint"];
    expect(filterDatabaseOptions(options, "")).toEqual(options);
    expect(filterDatabaseOptions(options, "   ")).toEqual(options);
  });

  it("prioritizes exact matches ahead of prefix and substring matches", () => {
    const options = ["tinyint", "tinyint unsigned", "smallint", "smallint unsigned", "mediumint", "mediumint unsigned", "int", "int unsigned", "integer", "integer unsigned", "bigint", "bigint unsigned", "point"];

    const result = filterDatabaseOptions(options, "int");

    // Exact match "int" must be first
    expect(result[0]).toBe("int");
    // Prefix matches come next, preserving relative order
    expect(result.slice(1, 4)).toEqual(["int unsigned", "integer", "integer unsigned"]);
    // Substring matches come last, preserving relative order
    expect(result.slice(4)).toEqual(["tinyint", "tinyint unsigned", "smallint", "smallint unsigned", "mediumint", "mediumint unsigned", "bigint", "bigint unsigned", "point"]);
  });

  it("handles case-insensitivity in exact matches", () => {
    const options = ["TINYINT", "INT", "BIGINT"];
    const result = filterDatabaseOptions(options, "int");
    expect(result[0]).toBe("INT");
  });

  it("prioritizes prefix matches ahead of substring matches", () => {
    const options = ["smallserial", "serial", "bigserial"];
    const result = filterDatabaseOptions(options, "ser");
    expect(result).toEqual(["serial", "smallserial", "bigserial"]);
  });

  it("prioritizes word-boundary matches ahead of substring matches", () => {
    const options = ["nonunsigned_value", "int unsigned", "sununsigned"];
    const result = filterDatabaseOptions(options, "unsigned");
    expect(result[0]).toBe("int unsigned");
    expect(result).toEqual(["int unsigned", "nonunsigned_value", "sununsigned"]);
  });

  it("preserves relative order for items within the same match tier", () => {
    const options = ["tinytext", "text", "mediumtext", "longtext"];
    const result = filterDatabaseOptions(options, "text");
    expect(result[0]).toBe("text");
    expect(result.slice(1)).toEqual(["tinytext", "mediumtext", "longtext"]);
  });

  it("supports custom displayName mappings", () => {
    const options = ["col_a", "col_b", "col_c"];
    const displayMap: Record<string, string> = {
      col_a: "Identifier",
      col_b: "Integer Count",
      col_c: "Int",
    };

    const result = filterDatabaseOptions(options, "int", (opt) => displayMap[opt] ?? opt);
    // col_c has label "Int", exact match
    expect(result[0]).toBe("col_c");
    // col_b has label "Integer Count", word-boundary prefix match
    expect(result[1]).toBe("col_b");
  });

  it("handles special characters without regex errors", () => {
    const options = ["int[]", "integer[]", "point", "geometry(point, 4326)"];
    expect(filterDatabaseOptions(options, "int[]")).toEqual(["int[]"]);
    expect(filterDatabaseOptions(options, "point")[0]).toBe("point");
    expect(filterDatabaseOptions(options, "geometry(")[0]).toBe("geometry(point, 4326)");
  });
});
