import { describe, expect, it } from "vitest";
import { sortStructureIndexColumnOptions } from "../tableStructureEditorState";

describe("sortStructureIndexColumnOptions", () => {
  const options = [{ name: "order_total" }, { name: "ID" }, { name: "amount2" }, { name: "amount10" }, { name: "customer" }];

  it("sorts unpicked columns alphabetically, case-insensitive and numeric-aware", () => {
    expect(sortStructureIndexColumnOptions(options, new Map()).map((option) => option.name)).toEqual(["amount2", "amount10", "customer", "ID", "order_total"]);
  });

  it("keeps picked columns first in their index order before the alphabetical tail", () => {
    const picked = new Map([
      ["customer", 2],
      ["ID", 1],
    ]);
    expect(sortStructureIndexColumnOptions(options, picked).map((option) => option.name)).toEqual(["ID", "customer", "amount2", "amount10", "order_total"]);
  });

  it("keeps the option payloads intact", () => {
    const picked = new Map([["ID", 1]]);
    const [first] = sortStructureIndexColumnOptions(options, picked);
    expect(first).toEqual({ name: "ID" });
  });
});
