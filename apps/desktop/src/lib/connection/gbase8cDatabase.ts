/**
 * GBase 8c 的 Agent 用 `jdbc:gbase8c://{host}:{port}/{database}` 拼 URL，数据库段为空时会退化成
 * `jdbc:gbase8c://host:port/`；实测厂商驱动此时拿**用户名**当库名去连，报出与输入无关的
 * `FATAL: database "dbx" does not exist`。所以「数据库」对 GBase 8c 是必填项——除非用户直接填了完整的
 * `connection_string`：`JdbcAgentProfile.buildUrl` 在它非空时原样使用，不再看 host/port/database。
 */
export function hasGbase8cConnectionDatabase(database: string | undefined, connectionString: string | undefined): boolean {
  return !!database?.trim() || !!connectionString?.trim();
}
