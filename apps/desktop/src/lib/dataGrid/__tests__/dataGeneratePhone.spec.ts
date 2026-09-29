import { describe, expect, it } from "vitest";
import { defaultGeneratorParams, generateValue, type ColumnAttrs } from "@/lib/dataGrid/dataGenerate";

function phoneParams(characterMaximumLength: number) {
  const attrs: ColumnAttrs = {
    dataType: `varchar(${characterMaximumLength})`,
    columnDefault: null,
    characterMaximumLength,
  };
  return defaultGeneratorParams("mobile", attrs, "phone");
}

describe("phone data generation (#10488)", () => {
  it("keeps automatically generated mobile values within varchar(11)", () => {
    const params = phoneParams(11);

    expect(params.maxLength).toBe(11);
    for (let row = 0; row < 50; row += 1) {
      const value = generateValue("mobile", "varchar(11)", "phone", row, params);
      expect(value).toEqual(expect.any(String));
      expect((value as string).length).toBeLessThanOrEqual(11);
    }
  });

  it("bounds phone values for columns shorter than a standard phone number", () => {
    const params = phoneParams(6);
    const value = generateValue("mobile", "varchar(6)", "phone", 0, params);

    expect(value).toMatch(/^\d{6}$/);
  });

  it("preserves configured region and formatting when the column is large enough", () => {
    const value = generateValue("mobile", "varchar(32)", "phone", 0, {
      phoneFormat: "international",
      phoneSeparator: true,
      phoneRegions: ["cn"],
      maxLength: 32,
    });

    expect(value).toMatch(/^\+86\d{11}$/);
  });

  it("keeps text generator length defaults unchanged", () => {
    const attrs: ColumnAttrs = { dataType: "varchar(11)", columnDefault: null, characterMaximumLength: 11 };
    const params = defaultGeneratorParams("note", attrs, "text");

    expect(params).toMatchObject({ minLength: 6, maxLength: 11 });
    expect((generateValue("note", "varchar(11)", "text", 0, params) as string).length).toBeLessThanOrEqual(11);
  });
});
