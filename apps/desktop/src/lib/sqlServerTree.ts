import type { ObjectInfo, TreeNode } from "@/types/database";
import { sortSidebarNames } from "@/lib/databaseTree";
import { buildGroupedObjectTreeNodes, buildObjectGroupPlaceholderNodes, buildSimpleObjectTreeNodes, type DatabaseObjectTreeKind } from "@/lib/tableTree";

export const SQLSERVER_DEFAULT_SCHEMA = "dbo";

function isDefaultSchema(schema: string): boolean {
  return schema.toLowerCase() === SQLSERVER_DEFAULT_SCHEMA;
}

export function buildSqlServerDatabaseTreeNodes(connectionId: string, database: string, schemas: string[], defaultSchemaObjects: ObjectInfo[], options: { lazyObjectTypes?: DatabaseObjectTreeKind[]; simpleObjectDisplay?: boolean } = {}): TreeNode[] {
  const databaseNodeId = `${connectionId}:${database}`;
  const defaultSchema = schemas.find(isDefaultSchema) || SQLSERVER_DEFAULT_SCHEMA;

  const defaultObjectNodes = options.lazyObjectTypes
    ? buildObjectGroupPlaceholderNodes({
        nodeId: databaseNodeId,
        connectionId,
        database,
        schema: defaultSchema,
        objectTypes: options.lazyObjectTypes,
      })
    : options.simpleObjectDisplay
      ? buildSimpleObjectTreeNodes({
          nodeId: databaseNodeId,
          connectionId,
          database,
          schema: defaultSchema,
          objects: defaultSchemaObjects,
        })
      : buildGroupedObjectTreeNodes({
          nodeId: databaseNodeId,
          connectionId,
          database,
          schema: defaultSchema,
          objects: defaultSchemaObjects,
        });

  const schemaNodes = sortSidebarNames(schemas.filter((schema) => !isDefaultSchema(schema))).map((schema) => ({
    id: `${databaseNodeId}:${schema}`,
    label: schema,
    type: "schema" as const,
    connectionId,
    database,
    schema,
    isExpanded: false,
    children: [],
  }));

  return [...defaultObjectNodes, ...schemaNodes];
}
