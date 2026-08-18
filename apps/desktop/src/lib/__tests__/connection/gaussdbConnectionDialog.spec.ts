import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("GaussDB connection dialog persistence", () => {
  it("preserves count-query DOP in submitted connection configs", () => {
    const source = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");
    const submitConfig = source.slice(source.indexOf("function connectionConfigForSubmit"), source.indexOf("function connectionNameForSubmit"));

    expect(submitConfig).toContain("const countQueryDop = gaussdbCountQueryDop(config);");
    expect(submitConfig).toContain("setGaussdbCountQueryDop(config, countQueryDop);");
  });
});
