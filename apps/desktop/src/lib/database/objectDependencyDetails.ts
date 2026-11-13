import type { DatabaseType, QueryResult, QueryTab, TriggerInfo } from "@/types/database";
import type { SqlObjectNavigationTarget, SqlObjectNavigationType } from "@/lib/sql/sqlNavigation";
import { BackendErrorException } from "@/lib/backend/errorUtils";
import { exactOracleTriggerMetadata } from "@/lib/database/oracleTriggerIdentity";
import { oracleObjectRelationsSql, oracleObjectRelationKinds, type ObjectRelationKind, type OracleDependencyObjectType } from "@/lib/database/oracleObjectDependencies";

export type ObjectDetails = NonNullable<QueryTab["objectDetails"]>;
export type ObjectDetailsSection = ObjectDetails["section"];
export function isObjectDependencySection(tab: QueryTab): boolean {
  const details = tab.objectDetails;
  return !!details && details.section !== "source" && details.connectionId === tab.connectionId && details.database === tab.database && details.schema === (tab.schema || tab.database) && (details.catalog || "") === (tab.catalog || "");
}
export interface ObjectDependencyTarget {
  connectionId: string;
  database: string;
  schema: string;
  catalog?: string;
  name: string;
  objectType: OracleDependencyObjectType;
  databaseType?: DatabaseType;
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

export function objectDependencyTarget(details: (Omit<ObjectDependencyTarget, "objectType"> & { objectType: string; section?: ObjectDetailsSection }) | undefined, databaseType?: DatabaseType, trigger?: Pick<TriggerInfo, "name" | "oracle_metadata"> | null): ObjectDependencyTarget | undefined {
  if (!details) return;
  const type = details.objectType === "PACKAGE_BODY" ? "PACKAGE" : details.objectType;
  if (type === "TRIGGER") {
    const metadata = exactOracleTriggerMetadata(trigger);
    if (!metadata || metadata.owner !== details.schema || metadata.name !== details.name || metadata.engine !== (databaseType === "dameng" ? "dm" : databaseType)) return;
    if (metadata.engine === "dm" && !/(?:^|\D)8\./.test(metadata.engineVersion ?? "")) return;
  } else if (databaseType !== "oracle" && databaseType !== "oceanbase-oracle") return;
  if (!["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "PACKAGE", "TYPE", "TYPE_BODY", "SEQUENCE", "SYNONYM", "TRIGGER", "INDEX"].includes(type)) return;
  const { section: _section, ...identity } = details;
  return { ...identity, objectType: type as OracleDependencyObjectType, ...(databaseType === "dameng" ? { databaseType } : {}) };
}

export function objectDependencySql(target: ObjectDependencyTarget, kind: ObjectRelationKind = "dependencies"): string {
  if (!objectRelationKinds(target).includes(kind)) throw new Error("This relation kind is not supported for this object.");
  return oracleObjectRelationsSql({ schema: target.schema, objectName: target.name, objectType: target.objectType }, kind);
}

export const objectRelationKinds = (target: ObjectDependencyTarget): ObjectRelationKind[] => (target.databaseType === "dameng" ? ["dependencies"] : oracleObjectRelationKinds(target.objectType));

export interface RelationObjectIdentity {
  schema: string;
  name: string;
  type: string;
}
export interface ObjectForeignKeyRow {
  kind: "foreignKey";
  direction: "REFERENCES" | "REFERENCED_BY";
  constraintOwner: string;
  constraintName: string;
  child: RelationObjectIdentity;
  parent: RelationObjectIdentity;
  columns: { position: number; child: string; parent: string }[];
  complete: boolean;
}
export interface ObjectOwnershipRow {
  kind: "ownership";
  child: RelationObjectIdentity;
  parent: RelationObjectIdentity;
}

function resultReader(result: QueryResult, required: string[]) {
  const indexes = new Map(result.columns.map((name, index) => [name.toUpperCase(), index]));
  if (required.some((name) => !indexes.has(name))) throw new Error("The relation query returned an unexpected column layout.");
  return (row: unknown[], name: string) => String(row[indexes.get(name)!] ?? "");
}

export function objectForeignKeyRows(result: QueryResult): ObjectForeignKeyRow[] {
  const value = resultReader(result, ["DIRECTION", "CONSTRAINT_OWNER", "CONSTRAINT_NAME", "CHILD_OWNER", "CHILD_NAME", "CHILD_COLUMN", "POSITION", "PARENT_OWNER", "PARENT_NAME", "PARENT_COLUMN", "COLUMN_COUNT"]);
  const groups = new Map<string, ObjectForeignKeyRow>();
  const expectedCounts = new Map<string, number>();
  for (const row of result.rows) {
    const get = (name: string) => value(row, name);
    const direction = get("DIRECTION");
    if (direction !== "REFERENCES" && direction !== "REFERENCED_BY") throw new Error("The foreign key query returned an unknown direction.");
    const key = JSON.stringify([direction, get("CONSTRAINT_OWNER"), get("CONSTRAINT_NAME")]);
    let group = groups.get(key);
    if (!group) {
      group = {
        kind: "foreignKey",
        direction,
        constraintOwner: get("CONSTRAINT_OWNER"),
        constraintName: get("CONSTRAINT_NAME"),
        child: { schema: get("CHILD_OWNER"), name: get("CHILD_NAME"), type: "TABLE" },
        parent: { schema: get("PARENT_OWNER"), name: get("PARENT_NAME"), type: "TABLE" },
        columns: [],
        complete: true,
      };
      groups.set(key, group);
      expectedCounts.set(key, Number(get("COLUMN_COUNT")));
    }
    group.columns.push({ position: Number(get("POSITION")), child: get("CHILD_COLUMN"), parent: get("PARENT_COLUMN") });
    if (!group.parent.name || !group.parent.schema || !get("PARENT_COLUMN") || !get("CHILD_COLUMN") || !Number(get("POSITION"))) group.complete = false;
    // COLUMN_COUNT is from the visible child constraint, not the truncated result.
    if (!Number(get("COLUMN_COUNT"))) group.complete = false;
  }
  for (const [key, group] of groups) {
    group.columns.sort((a, b) => a.position - b.position);
    group.complete &&= group.columns.length === expectedCounts.get(key) && group.columns.every((column, index) => column.position === index + 1);
  }
  return [...groups.values()];
}

export function objectOwnershipRows(result: QueryResult): ObjectOwnershipRow[] {
  const value = resultReader(result, ["CHILD_OWNER", "CHILD_NAME", "CHILD_TYPE", "PARENT_OWNER", "PARENT_NAME", "PARENT_TYPE"]);
  return result.rows.map((row) => ({ kind: "ownership", child: { schema: value(row, "CHILD_OWNER"), name: value(row, "CHILD_NAME"), type: value(row, "CHILD_TYPE") }, parent: { schema: value(row, "PARENT_OWNER"), name: value(row, "PARENT_NAME"), type: value(row, "PARENT_TYPE") } }));
}

export function relationObjectNavigation(object: RelationObjectIdentity): SqlObjectNavigationTarget | undefined {
  return objectDependencyNavigation({ direction: "DEPENDS_ON", ...object, dependencyType: "", link: "", sourceType: "" });
}

export function objectOwnershipNavigation(row: ObjectOwnershipRow): SqlObjectNavigationTarget | undefined {
  if (row.child.type !== "INDEX") return relationObjectNavigation(row.child);
  if (!row.child.name || !row.child.schema || row.parent.type !== "TABLE" || !row.parent.name || !row.parent.schema) return;
  return { name: row.child.name, schema: row.child.schema, type: "index", parentName: row.parent.name, parentSchema: row.parent.schema, nameQuoted: true, schemaQuoted: true, parentNameQuoted: true, parentSchemaQuoted: true };
}

export function objectDependencyRows(result: QueryResult): ObjectDependencyRow[] {
  if (result.execution_error) throw new BackendErrorException(result.error || "The dependency query failed.");
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
    SYNONYM: "synonym",
    TRIGGER: "trigger",
  };
  const type = types[row.type];
  if (!type) return;
  return { name: row.name, schema: row.schema, type, nameQuoted: true, schemaQuoted: true };
}
