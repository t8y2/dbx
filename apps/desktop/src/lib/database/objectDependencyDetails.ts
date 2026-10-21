import type { DatabaseType, QueryResult, QueryTab } from "@/types/database";
import type { SqlObjectNavigationTarget, SqlObjectNavigationType } from "@/lib/sql/sqlNavigation";
import { oracleObjectDependenciesSql, type OracleDependencyObjectType } from "@/lib/database/oracleObjectDependencies";

export type ObjectDetails = NonNullable<QueryTab["objectDetails"]>;
export type ObjectDetailsSection = ObjectDetails["section"];
export function isObjectDependencySection(tab: QueryTab): boolean {
  const details = tab.objectDetails;
  return !!details && details.section !== "source" && details.connectionId === tab.connectionId && details.database === tab.database && details.schema === (tab.schema || tab.database) && (details.catalog || "") === (tab.catalog || "");
}
export interface ObjectDependencyTarget extends Omit<ObjectDetails, "section" | "objectType"> {
  objectType: OracleDependencyObjectType;
}

export interface ObjectDependencyRow {
  direction: "DEPENDS_ON" | "REFERENCED_BY";
  name: string;
  schema: string;
  type: string;
  dependencyType: string;
  link: string;
  sourceType: string;
}

export function objectDependencyTarget(details: QueryTab["objectDetails"], databaseType?: DatabaseType): ObjectDependencyTarget | undefined {
  if (!details || (databaseType !== "oracle" && databaseType !== "oceanbase-oracle")) return;
  const type = details.objectType === "PACKAGE_BODY" ? "PACKAGE" : details.objectType;
  if (type !== "PROCEDURE" && type !== "FUNCTION" && type !== "PACKAGE") return;
  const { section: _section, ...identity } = details;
  return { ...identity, objectType: type };
}

export function objectDependencySql(target: ObjectDependencyTarget): string {
  return oracleObjectDependenciesSql({ schema: target.schema, objectName: target.name, objectType: target.objectType });
}

export function objectDependencyRows(result: QueryResult): ObjectDependencyRow[] {
  const indexes = new Map(result.columns.map((name, index) => [name.toUpperCase(), index]));
  const required = ["DIRECTION", "OBJECT_OWNER", "OBJECT_NAME", "OBJECT_TYPE", "REFERENCED_OWNER", "REFERENCED_NAME", "REFERENCED_TYPE", "DEPENDENCY_TYPE", "REFERENCED_LINK_NAME"];
  if (required.some((name) => !indexes.has(name))) throw new Error("The dependency query returned an unexpected column layout.");
  return result.rows.map((row) => {
    const value = (name: string) => String(row[indexes.get(name)!] ?? "");
    const direction = value("DIRECTION");
    if (direction !== "DEPENDS_ON" && direction !== "REFERENCED_BY") throw new Error("The dependency query returned an unknown direction.");
    const prefix = direction === "DEPENDS_ON" ? "REFERENCED_" : "OBJECT_";
    return {
      direction,
      name: value(prefix + "NAME"),
      schema: value(prefix + "OWNER"),
      type: value(prefix + "TYPE"),
      dependencyType: value("DEPENDENCY_TYPE"),
      link: value("REFERENCED_LINK_NAME"),
      sourceType: value("OBJECT_TYPE"),
    };
  });
}

/** Strict dictionary mapping: unknown/remote objects must never fall back to TABLE. */
export function objectDependencyNavigation(row: ObjectDependencyRow): SqlObjectNavigationTarget | undefined {
  if (row.link || !row.name || !row.schema) return;
  const types: Partial<Record<string, SqlObjectNavigationType>> = {
    TABLE: "table",
    VIEW: "view",
    "MATERIALIZED VIEW": "materialized_view",
    PROCEDURE: "procedure",
    FUNCTION: "function",
    PACKAGE: "package",
    "PACKAGE BODY": "package_body",
    SEQUENCE: "sequence",
    TRIGGER: "trigger",
  };
  const type = types[row.type];
  if (!type) return;
  return { name: row.name, schema: row.schema, type, nameQuoted: true, schemaQuoted: true };
}
