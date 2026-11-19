import { describe, expect, it } from "vitest";
import { sortStructureIndexesByColumns } from "@/lib/table/structureIndexSort";

function index(id: string, columns: string[], isPrimary = false) {
  return { id, columns, isPrimary };
}

describe("sortStructureIndexesByColumns", () => {
  const indexes = [index("composite", ["last_name", "first_name"]), index("primary", ["id"], true), index("id", ["id"]), index("last_name", ["last_name"])];

  it("sorts by the joined key-column list and keeps the primary key first", () => {
    expect(sortStructureIndexesByColumns(indexes, "asc").map((item) => item.id)).toEqual(["primary", "id", "last_name", "composite"]);
  });

  it("reverses the maintenance indexes but never moves the primary key", () => {
    expect(sortStructureIndexesByColumns(indexes, "desc").map((item) => item.id)).toEqual(["primary", "composite", "last_name", "id"]);
  });

  it("compares column names case-insensitively", () => {
    expect(sortStructureIndexesByColumns([index("upper", ["B"]), index("lower", ["a"])], "asc").map((item) => item.id)).toEqual(["lower", "upper"]);
  });
});
