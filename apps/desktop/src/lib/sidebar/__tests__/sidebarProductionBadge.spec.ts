import { describe, expect, it } from "vitest";
import { sidebarProductionBadgeScope, showSidebarRowProductionBadge, showSidebarStickyProductionBadge } from "../sidebarProductionBadge";
import { assessProductionSql } from "@/lib/database/productionSafety";
import type { ConnectionConfig, ProductionBadgeScope, TreeNodeType } from "@/types/database";

const connection: ConnectionConfig = { id: "c", name: "prod", db_type: "postgres", host: "localhost", port: 5432, username: "", password: "", is_production: true };
const node = (type: TreeNodeType, database = "app") => ({ type, database });

describe("production badge display scope", () => {
  it("defaults old and missing connections to database scope", () => {
    expect(sidebarProductionBadgeScope(connection)).toBe("database");
    expect(sidebarProductionBadgeScope(undefined)).toBe("database");
    expect(sidebarProductionBadgeScope({ ...connection, production_badge_scope: "unknown" as ProductionBadgeScope })).toBe("database");
  });

  it.each(["connection", "database", "table"] as const)("retains the connection marker in %s scope", (scope) => {
    expect(showSidebarRowProductionBadge(node("connection"), { ...connection, production_badge_scope: scope })).toBe(true);
  });

  it.each(["database", "schema", "table", "view", "procedure", "mongo-collection", "nacos-namespace"] as const)("respects the selected range on ordinary %s rows", (type) => {
    for (const scope of ["connection", "database", "table"] as const) {
      expect(showSidebarRowProductionBadge(node(type), { ...connection, production_badge_scope: scope })).toBe(scope === "table" || (scope === "database" && ["database", "schema", "nacos-namespace"].includes(type)));
    }
  });

  it.each(["group-tables", "column", "index", "connection-group", "table-search-control"] as const)("keeps %s unmarked in table scope", (type) => {
    expect(showSidebarRowProductionBadge(node(type), { ...connection, production_badge_scope: "table" })).toBe(false);
  });

  it.each(["connection", "database", "table"] as const)("resolves the sticky badge in %s scope", (scope) => {
    const config = { ...connection, production_badge_scope: scope };
    expect(showSidebarStickyProductionBadge(node("schema"), config)).toBe(scope === "connection");
    expect(showSidebarRowProductionBadge(node("database"), config, true)).toBe(scope !== "connection");
    expect(showSidebarStickyProductionBadge(undefined, config)).toBe(false);
  });

  it("does not transfer database-only production markers to other databases", () => {
    const config = { ...connection, is_production: false, production_databases: ["app"], production_badge_scope: "table" as const };
    expect(showSidebarRowProductionBadge(node("connection", ""), config)).toBe(false);
    expect(showSidebarRowProductionBadge(node("schema"), config)).toBe(true);
    expect(showSidebarRowProductionBadge(node("table", "other"), config)).toBe(false);
    expect(showSidebarStickyProductionBadge(node("schema", "other"), config)).toBe(false);
  });

  it.each(["connection", "database", "table"] as const)("clears the fixed marker when entering a non-production database in %s scope", (scope) => {
    const config = { ...connection, is_production: false, production_databases: ["app"], production_badge_scope: scope };
    expect(showSidebarStickyProductionBadge(node("schema"), config)).toBe(scope === "connection");
    expect(showSidebarStickyProductionBadge(node("schema", "other"), config)).toBe(false);
    expect(showSidebarStickyProductionBadge(node("schema"), { ...config, production_databases: [] })).toBe(false);
  });

  it("warns on the connection for selected production databases in connection-only mode", () => {
    const config = { ...connection, is_production: false, production_databases: ["app"], production_badge_scope: "connection" as const };
    expect(showSidebarRowProductionBadge(node("connection", ""), config)).toBe(true);
    expect(showSidebarRowProductionBadge(node("table"), config)).toBe(false);
    expect(assessProductionSql("DELETE FROM orders", config, "other").active).toBe(false);
    expect(assessProductionSql("DELETE FROM orders", config, "app").active).toBe(true);
  });

  it.each(["connection", "database", "table"] as const)("leaves SQL production protection intact in %s scope", (scope) => {
    const config = { ...connection, production_badge_scope: scope };
    expect(assessProductionSql("DELETE FROM orders", config, "app")).toMatchObject({ active: true, isMutation: true, reason: "connection" });
    expect(assessProductionSql("DELETE FROM app.orders", { ...config, db_type: "mysql", is_production: false, production_databases: ["app"] }, "other")).toMatchObject({ active: true, isMutation: true });
  });
});
