import { describe, expect, it } from "vitest";
import { buildAllDatabaseExportPlan, filterExportableSchemas } from "@/lib/export/databaseExport";
import { XUGU_PUBLIC_SYNONYM_SCOPE, XUGU_SCHEDULER_JOB_SCOPE } from "@/lib/sidebar/xuguPublicSynonyms";

describe("database export schema selection", () => {
  it("hides Xugu synthetic tree scopes while preserving real schemas", () => {
    const schemas = ["APP_TEST", "GUEST", XUGU_PUBLIC_SYNONYM_SCOPE, XUGU_SCHEDULER_JOB_SCOPE];

    expect(filterExportableSchemas(schemas, "xugu")).toEqual(["APP_TEST", "GUEST"]);
  });

  it("does not apply Xugu filtering to other database types", () => {
    const schemas = ["APP_TEST", XUGU_PUBLIC_SYNONYM_SCOPE, XUGU_SCHEDULER_JOB_SCOPE];

    expect(filterExportableSchemas(schemas, "postgres")).toEqual(schemas);
  });

  it("excludes synthetic scopes from an all-database Xugu export plan", () => {
    expect(
      buildAllDatabaseExportPlan({
        databases: ["SHOP_DEMO"],
        schemaAware: true,
        dbType: "xugu",
        schemasByDatabase: {
          SHOP_DEMO: ["APP_TEST", XUGU_PUBLIC_SYNONYM_SCOPE, XUGU_SCHEDULER_JOB_SCOPE],
        },
      }),
    ).toEqual([
      {
        database: "SHOP_DEMO",
        schema: "APP_TEST",
        fileStem: "SHOP_DEMO",
        displayName: "SHOP_DEMO",
      },
    ]);
  });
});
