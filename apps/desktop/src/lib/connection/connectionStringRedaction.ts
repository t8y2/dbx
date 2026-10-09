import { isSecretConnectionProperty, redactJdbcProperties, redactSqlServerQuery } from "@/lib/connection/jdbcProperties";

/** Shared by copyable connection strings and sidebar previews. */
export function redactConnectionStringSecrets(value: string): string {
  // Password-only userinfo (for example redis://:password@host) is valid too.
  const withoutUserInfo = value.replace(/(:\/\/[^/\s:@?#;]*):([^@\s/?#;]+)@/g, "$1:***@");
  const properties = withoutUserInfo.match(/^(jdbc:sqlserver:\/\/[^;]*;)([\s\S]*)$/i) ?? withoutUserInfo.match(/^(jdbc:teradata:\/\/[^/]*\/)([\s\S]*)$/i);
  if (properties) return properties[1] + redactJdbcProperties(properties[2], /^jdbc:sqlserver:/i.test(withoutUserInfo) ? "sqlserver" : "teradata");
  const sqlServerQuery = withoutUserInfo.match(/^(mssql:\/\/[^?]*\?)([\s\S]*)$/i);
  if (sqlServerQuery) return sqlServerQuery[1] + redactSqlServerQuery(sqlServerQuery[2]);
  return withoutUserInfo.replace(/([?&;])([^=?&;]+)=([^&;]*)/g, (part, separator: string, key: string) => (isSecretConnectionProperty(key) ? `${separator}${key}=***` : part));
}
