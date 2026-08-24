import { databaseTypesWithTrait } from "@/lib/database/databaseDriverManifest";

export const SCHEMA_AWARE_TYPES = databaseTypesWithTrait("schemaAware");

// Engines where an object can be addressed as database/catalog.schema.table.
// Keep this narrower than SCHEMA_AWARE_TYPES: PostgreSQL, for example, cannot
// query another database through a three-part name on the same connection.
export const DATABASE_SCHEMA_QUALIFIED_TYPES = databaseTypesWithTrait("databaseSchemaQualified");

export const SINGLE_DATABASE_TYPES = databaseTypesWithTrait("singleDatabase");

export const CLEARABLE_QUERY_SCHEMA_TYPES = databaseTypesWithTrait("clearableQuerySchema");

export const FETCH_FIRST_TYPES = databaseTypesWithTrait("fetchFirst");

export const TREE_SCHEMA_TYPES = databaseTypesWithTrait("treeSchema");

export const DATABASE_OBJECT_TREE_TYPES = databaseTypesWithTrait("databaseObjectTree");

export const PG_VACUUM_TYPES = databaseTypesWithTrait("pgVacuum");

export const PG_LIKE_STRUCTURE_TYPES = databaseTypesWithTrait("pgLikeStructure");

export const DIAGRAM_SQL_TYPES = databaseTypesWithTrait("diagramSql");
