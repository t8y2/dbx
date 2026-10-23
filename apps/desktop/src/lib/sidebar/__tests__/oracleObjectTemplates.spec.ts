import { describe, expect, it } from "vitest";
import { buildOracleObjectTemplate, oracleObjectTemplateForGroup } from "@/lib/sidebar/oracleObjectTemplates";

describe("Oracle object templates", () => {
  it("creates a schema-qualified trigger draft from the Oracle trigger group", () => {
    const template = oracleObjectTemplateForGroup({ db_type: "oracle", driver_profile: "oracle" }, { type: "group-triggers", database: "dbo", schema: "HR" });

    expect(template?.kind).toBe("trigger");
    expect(template?.sql).toContain('CREATE OR REPLACE TRIGGER "HR"."NEW_TRIGGER"');
    expect(template?.sql).toContain('BEFORE INSERT ON "HR"."TABLE_NAME"');
    expect(template?.sql).toContain("BEGIN\n  NULL;\nEND;\n/");
  });

  it("is limited to Oracle trigger groups", () => {
    expect(oracleObjectTemplateForGroup({ db_type: "oracle", driver_profile: "oracle" }, { type: "group-tables", database: "dbo", schema: "HR" })).toBeNull();
    expect(oracleObjectTemplateForGroup({ db_type: "mysql", driver_profile: "mysql" }, { type: "group-triggers", database: "db", schema: "db" })).toBeNull();
  });

  it("escapes quoted schema names", () => {
    expect(buildOracleObjectTemplate('HR"X').sql).toContain('"HR""X"."TABLE_NAME"');
  });
});
