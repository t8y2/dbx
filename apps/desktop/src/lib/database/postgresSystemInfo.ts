import type { PostgresSystemCategory } from "./postgresAdministration";
/** Explicit projections avoid catalogue columns introduced in recent PG versions. */
export function postgresSystemInfoSql(category: PostgresSystemCategory): string {
  switch (category) {
    case "accessMethods":
      return "SELECT amname AS name, amhandler::text AS handler FROM pg_catalog.pg_am ORDER BY amname";
    case "encodings":
      return `SELECT id, pg_catalog.pg_encoding_to_char(id) AS name,
      pg_catalog.pg_encoding_to_char(id) = current_setting('server_encoding') AS current_database_encoding
      FROM generate_series(0, 41) AS id WHERE pg_catalog.pg_encoding_to_char(id) <> '' ORDER BY id`;
    case "collations":
      return `SELECT n.nspname AS schema, c.collname AS name, c.collencoding AS encoding,
      pg_catalog.pg_get_userbyid(c.collowner) AS owner
      FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid = c.collnamespace
      ORDER BY n.nspname, c.collname`;
    case "languages":
      return `SELECT lanname AS name, lanpltrusted AS trusted, lanispl AS procedural,
      pg_catalog.pg_get_userbyid(lanowner) AS owner FROM pg_catalog.pg_language ORDER BY lanname`;
    case "extensions":
      return "SELECT name, default_version, installed_version, comment FROM pg_catalog.pg_available_extensions ORDER BY name";
  }
}
