import { describe, expect, it } from "vitest";
import { schemaOptionsForConnection } from "@/composables/useSchemaOptions";

describe("schemaOptionsForConnection", () => {
  it("sorts schema names with numeric suffixes naturally", () => {
    const schemaNames = ["WMWMSE16", "WMWMSE17", "WMWMSE18", "WMWMSE19", "WMWMSE2", "WMWMSE20", "WMWMSE1", "WMWMSE10"];

    expect(schemaOptionsForConnection(schemaNames, undefined)).toEqual(["WMWMSE1", "WMWMSE2", "WMWMSE10", "WMWMSE16", "WMWMSE17", "WMWMSE18", "WMWMSE19", "WMWMSE20"]);
    expect(schemaNames).toEqual(["WMWMSE16", "WMWMSE17", "WMWMSE18", "WMWMSE19", "WMWMSE2", "WMWMSE20", "WMWMSE1", "WMWMSE10"]);
  });

  it("sorts after applying the visible schema filter", () => {
    const connection = {
      db_type: "oracle" as const,
      visible_schemas: {
        ORCL: ["WMWMSE10", "WMWMSE2"],
      },
    };

    expect(schemaOptionsForConnection(["WMWMSE10", "SYSTEM", "WMWMSE2", "WMWMSE1"], connection, "ORCL")).toEqual(["WMWMSE2", "WMWMSE10"]);
  });
});
