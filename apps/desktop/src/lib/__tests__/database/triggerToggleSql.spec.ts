import { describe, expect, it } from "vitest";
import { buildTriggerToggleSql, supportsTriggerToggle } from "@/lib/database/triggerToggleSql";

describe("triggerToggleSql", () => {
  describe("exact Oracle-family actions", () => {
    it.each(["oracle", "oceanbase-oracle", "dameng"] as const)("%s preserves raw trigger owner/name independently of a parent", (databaseType) => {
      expect(buildTriggerToggleSql({ databaseType, schema: " Owner ", triggerName: ' Tr"ig ', tableName: "must-not-appear", enabled: false, identityMode: "exact", scope: "VIEW" })).toBe('ALTER TRIGGER " Owner "." Tr""ig " DISABLE;');
    });

    it.each(["SCHEMA", "DATABASE", "TIMER"] as const)("DM %s toggles only the selected native event trigger", (scope) => {
      expect(buildTriggerToggleSql({ databaseType: "dameng", schema: " O'wner ", triggerName: " Tr'ig ", enabled: false, identityMode: "exact", scope })).toBe("SP_ENABLE_EVT_TRIGGER(' O''wner ', ' Tr''ig ', 0);");
      expect(buildTriggerToggleSql({ databaseType: "dameng", schema: " O'wner ", triggerName: " Tr'ig ", enabled: true, identityMode: "exact", scope })).toBe("SP_ENABLE_EVT_TRIGGER(' O''wner ', ' Tr''ig ', 1);");
    });

    it("does not fall back to a legacy or unknown-scope write when exact prerequisites are missing", () => {
      const options = { databaseType: "oracle", schema: "APP", triggerName: "T", enabled: true, identityMode: "exact", scope: "TABLE" } as const;
      expect(buildTriggerToggleSql({ ...options, schema: undefined })).toBeNull();
      expect(buildTriggerToggleSql({ ...options, triggerName: "T\0" })).toBeNull();
      expect(buildTriggerToggleSql({ ...options, scope: "UNKNOWN" })).toBeNull();
      expect(buildTriggerToggleSql({ ...options, databaseType: "oceanbase-oracle", scope: "SCHEMA" })).toBeNull();
      expect(buildTriggerToggleSql({ ...options, databaseType: "postgres", tableName: "ORDERS" })).toBeNull();
    });

    it("keeps default callers' original trim, optional owner and native DM behavior", () => {
      expect(buildTriggerToggleSql({ databaseType: "dameng", schema: " APP ", triggerName: " T ", enabled: false })).toBe('ALTER TRIGGER "APP"."T" DISABLE;');
      expect(buildTriggerToggleSql({ databaseType: "oracle", triggerName: " T ", enabled: true })).toBe('ALTER TRIGGER "T" ENABLE;');
    });
  });

  describe("supportsTriggerToggle", () => {
    it("returns true for supported database types", () => {
      expect(supportsTriggerToggle("sqlserver")).toBe(true);
      expect(supportsTriggerToggle("oracle")).toBe(true);
      expect(supportsTriggerToggle("oceanbase-oracle")).toBe(true);
      expect(supportsTriggerToggle("dameng")).toBe(true);
      expect(supportsTriggerToggle("postgres")).toBe(true);
      expect(supportsTriggerToggle("kingbase")).toBe(true);
      expect(supportsTriggerToggle("opengauss")).toBe(true);
      expect(supportsTriggerToggle("vastbase")).toBe(true);
      expect(supportsTriggerToggle("highgo")).toBe(true);
      expect(supportsTriggerToggle("uxdb")).toBe(true);
      expect(supportsTriggerToggle("gaussdb")).toBe(true);
      expect(supportsTriggerToggle("kwdb")).toBe(true);
      expect(supportsTriggerToggle("xugu")).toBe(true);
      expect(supportsTriggerToggle("firebird")).toBe(true);
    });

    it("returns false for unsupported database types or undefined", () => {
      expect(supportsTriggerToggle("mysql")).toBe(false);
      expect(supportsTriggerToggle("sqlite")).toBe(false);
      expect(supportsTriggerToggle("clickhouse")).toBe(false);
      expect(supportsTriggerToggle(undefined)).toBe(false);
    });
  });

  describe("buildTriggerToggleSql", () => {
    it("generates SQL Server table trigger enable/disable SQL", () => {
      expect(
        buildTriggerToggleSql({
          databaseType: "sqlserver",
          schema: "dbo",
          tableName: "orders",
          triggerName: "trg_orders_audit",
          enabled: true,
        }),
      ).toBe("ENABLE TRIGGER [dbo].[trg_orders_audit] ON [dbo].[orders];");

      expect(
        buildTriggerToggleSql({
          databaseType: "sqlserver",
          schema: "dbo",
          tableName: "orders",
          triggerName: "trg_orders_audit",
          enabled: false,
        }),
      ).toBe("DISABLE TRIGGER [dbo].[trg_orders_audit] ON [dbo].[orders];");
    });

    it("generates SQL Server table trigger SQL without schema", () => {
      expect(
        buildTriggerToggleSql({
          databaseType: "sqlserver",
          tableName: "orders",
          triggerName: "trg_orders_audit",
          enabled: true,
        }),
      ).toBe("ENABLE TRIGGER [trg_orders_audit] ON [orders];");
    });

    it("generates SQL Server database-level trigger SQL", () => {
      expect(
        buildTriggerToggleSql({
          databaseType: "sqlserver",
          triggerName: "ddl_trg_database",
          enabled: true,
        }),
      ).toBe("ENABLE TRIGGER [ddl_trg_database] ON DATABASE;");

      expect(
        buildTriggerToggleSql({
          databaseType: "sqlserver",
          triggerName: "ddl_trg_database",
          enabled: false,
        }),
      ).toBe("DISABLE TRIGGER [ddl_trg_database] ON DATABASE;");
    });

    it("escapes brackets for SQL Server identifiers", () => {
      expect(
        buildTriggerToggleSql({
          databaseType: "sqlserver",
          schema: "d]bo",
          tableName: "ord]ers",
          triggerName: "trg]audit",
          enabled: true,
        }),
      ).toBe("ENABLE TRIGGER [d]]bo].[trg]]audit] ON [d]]bo].[ord]]ers];");
    });

    it("generates Oracle / OceanBase / Dameng / Xugu trigger enable/disable SQL", () => {
      for (const databaseType of ["oracle", "oceanbase-oracle", "dameng", "xugu"] as const) {
        expect(
          buildTriggerToggleSql({
            databaseType,
            schema: "HR",
            tableName: "ORDERS",
            triggerName: "TRG_ORDERS_BI",
            enabled: true,
          }),
        ).toBe('ALTER TRIGGER "HR"."TRG_ORDERS_BI" ENABLE;');

        expect(
          buildTriggerToggleSql({
            databaseType,
            schema: "HR",
            tableName: "ORDERS",
            triggerName: "TRG_ORDERS_BI",
            enabled: false,
          }),
        ).toBe('ALTER TRIGGER "HR"."TRG_ORDERS_BI" DISABLE;');

        expect(
          buildTriggerToggleSql({
            databaseType,
            triggerName: "TRG_ORDERS_BI",
            enabled: false,
          }),
        ).toBe('ALTER TRIGGER "TRG_ORDERS_BI" DISABLE;');
      }
    });

    it("generates PostgreSQL family table trigger enable/disable SQL", () => {
      for (const databaseType of ["postgres", "kingbase", "opengauss", "vastbase"] as const) {
        expect(
          buildTriggerToggleSql({
            databaseType,
            schema: "public",
            tableName: "orders",
            triggerName: "trg_orders_audit",
            enabled: true,
          }),
        ).toBe('ALTER TABLE "public"."orders" ENABLE TRIGGER "trg_orders_audit";');

        expect(
          buildTriggerToggleSql({
            databaseType,
            schema: "public",
            tableName: "orders",
            triggerName: "trg_orders_audit",
            enabled: false,
          }),
        ).toBe('ALTER TABLE "public"."orders" DISABLE TRIGGER "trg_orders_audit";');
      }
    });

    it("generates Firebird trigger enable/disable SQL", () => {
      expect(
        buildTriggerToggleSql({
          databaseType: "firebird",
          tableName: "orders",
          triggerName: "trg_orders_audit",
          enabled: true,
        }),
      ).toBe('ALTER TRIGGER "trg_orders_audit" ACTIVE;');

      expect(
        buildTriggerToggleSql({
          databaseType: "firebird",
          triggerName: 'trg_"orders"_audit',
          enabled: false,
        }),
      ).toBe('ALTER TRIGGER "trg_""orders""_audit" INACTIVE;');
    });

    it("returns null for PostgreSQL when tableName is missing", () => {
      expect(
        buildTriggerToggleSql({
          databaseType: "postgres",
          triggerName: "trg_orders_audit",
          enabled: true,
        }),
      ).toBeNull();
    });

    it("returns null for unsupported database types or empty trigger name", () => {
      expect(
        buildTriggerToggleSql({
          databaseType: "mysql",
          tableName: "orders",
          triggerName: "trg_orders_audit",
          enabled: true,
        }),
      ).toBeNull();

      expect(
        buildTriggerToggleSql({
          databaseType: "sqlserver",
          tableName: "orders",
          triggerName: "   ",
          enabled: true,
        }),
      ).toBeNull();
    });
  });
});
