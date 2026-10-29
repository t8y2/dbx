import { LITERAL_PARAMETER_SYNTAX, QUERY_PARAMETER_SYNTAX, SQLSERVER_PARAMETER_SYNTAX, TERADATA_PARAMETER_SYNTAX, type ParameterSyntax } from "./connectionParameterDocument";
import { MYSQL_DATA_CHARSETS } from "./mysqlDataCharset";

export interface ConnectionParameterContext {
  db_type: string;
  driver_profile?: string;
  connection_string?: string;
}

export interface ConnectionParameterDefinition {
  name: string;
  aliases?: string[];
  type: "string" | "boolean" | "integer" | "enum" | "file";
  choices?: string[];
  /** Informational only: a default is never persisted as an explicit override. */
  defaultValue?: string;
  min?: number;
  max?: number;
  repeatable?: boolean;
  secret?: boolean;
  required?: boolean;
  description: string;
  descriptionZh?: string;
  descriptionKey?: string;
  source: "dbx" | "driver";
  /** Existing controls edit the same url_params string, rather than separate copies. */
  managedBy?: "tls" | "charset";
}

export interface ConnectionParameterMetadata {
  available: boolean;
  parameters: ConnectionParameterDefinition[];
}

const param = (name: string, type: ConnectionParameterDefinition["type"], description: string, descriptionZh: string, options: Partial<ConnectionParameterDefinition> = {}): ConnectionParameterDefinition => ({ name, type, description, descriptionZh, source: "dbx", ...options });

// These are DBX's actual native transport options, not Connector/J's property list.
// JDBC-reported definitions are merged separately and stay scoped to that driver.
const MYSQL_PARAMETERS = [
  param("charset", "string", "Connection character set. DBX uses utf8mb4 when omitted.", "连接字符集；未指定时 DBX 使用 utf8mb4。", { defaultValue: "utf8mb4" }),
  param("dataCharset", "enum", "Read-only decoding of historical bytes stored in latin1 text columns.", "以只读方式解码存放在 latin1 文本列中的历史字节。", { choices: [...MYSQL_DATA_CHARSETS], managedBy: "charset", descriptionKey: "connection.mysqlDataCharsetHint" }),
  param("time_zone", "string", "Set the session time zone, for example +08:00 or UTC.", "设置会话时区，例如 +08:00 或 UTC。", { aliases: ["time-zone", "timezone"] }),
  param("sessionVariables", "string", "Session variable assignments using Connector/J syntax.", "按 MySQL Connector/J 语法填写会话变量赋值。", { descriptionKey: "connection.sessionVariablesHint" }),
  param("localInfilePath", "file", "Explicitly allow a file for LOAD DATA LOCAL INFILE. Repeat for multiple files.", "明确授权 LOAD DATA LOCAL INFILE 可读取的文件；多个文件可重复添加。", { repeatable: true, descriptionKey: "connection.localInfilePathHint" }),
  param("connect_timeout", "integer", "Connection timeout in seconds.", "连接超时时间，单位为秒。", { min: 1, max: 300, aliases: ["connectTimeout"] }),
  param("ssl-mode", "enum", "TLS mode, shared with the TLS/SSL tab.", "TLS 连接模式，与 TLS/SSL 页共用配置。", { aliases: ["sslmode"], choices: ["disabled", "preferred", "required", "verify_ca", "verify_identity"], managedBy: "tls" }),
  param("ssl-cert", "file", "Client certificate path on the machine running DBX.", "运行 DBX 的主机上的客户端证书路径。", { aliases: ["sslcert"], managedBy: "tls" }),
  param("ssl-key", "file", "Client private key path on the machine running DBX.", "运行 DBX 的主机上的客户端私钥路径。", { aliases: ["sslkey"], managedBy: "tls", secret: true }),
  param("enable_cleartext_plugin", "boolean", "Allow the cleartext authentication plugin.", "允许明文密码认证插件。", { aliases: ["allowCleartextPasswords"] }),
  param("setupMode", "enum", "DBX connection initialization mode for MySQL-compatible gateways.", "DBX 对 MySQL 兼容网关执行的连接初始化模式。", { aliases: ["setup_mode"], choices: ["standard", "compatible", "literal_floor"] }),
  param("proxysql", "boolean", "Use initialization compatible with ProxySQL.", "使用兼容 ProxySQL 的初始化方式。"),
];

const POSTGRES_PARAMETERS = [
  param("application_name", "string", "Application name reported to the server.", "向服务端报告的应用名称。"),
  param("connect_timeout", "integer", "Connection timeout in seconds.", "连接超时时间，单位为秒。", { min: 1 }),
  param("options", "string", "Server startup options, such as -c search_path=app,public.", "服务端启动选项，例如 -c search_path=app,public。"),
  param("currentSchema", "string", "Default schema translated by DBX into PostgreSQL startup options.", "默认 Schema；DBX 将其转换为 PostgreSQL 启动选项。"),
  param("sslmode", "enum", "TLS mode, shared with the TLS/SSL tab.", "TLS 连接模式，与 TLS/SSL 页共用配置。", { choices: ["disable", "prefer", "require", "verify-ca", "verify-full"], managedBy: "tls" }),
  param("sslrootcert", "file", "Root CA certificate path.", "根 CA 证书路径。", { managedBy: "tls" }),
  param("sslcert", "file", "Client certificate path.", "客户端证书路径。", { managedBy: "tls" }),
  param("sslkey", "file", "Client private key path.", "客户端私钥路径。", { managedBy: "tls", secret: true }),
];

const ORACLE_PARAMETERS = [
  param("DBX_LEGACY_CHARSET", "enum", "Historical byte compatibility for US7ASCII databases using the Thin driver.", "Thin 驱动对 US7ASCII 数据库历史字节的兼容编码。", {
    choices: ["ZHS16GBK", "ZHS32GB18030", "AL32UTF8", "ZHT16MSWIN950"],
    descriptionKey: "connection.oracleLegacyCharsetHint",
  }),
];

export function connectionParameterSyntax(context: ConnectionParameterContext): ParameterSyntax {
  const url = context.connection_string?.trim().toLowerCase() ?? "";
  if (context.db_type === "sqlserver" || url.startsWith("jdbc:sqlserver:")) return SQLSERVER_PARAMETER_SYNTAX;
  if (context.db_type === "teradata" || url.startsWith("jdbc:teradata:")) return TERADATA_PARAMETER_SYNTAX;
  if (["db2", "informix", "gbase8s"].includes(context.db_type) || /^jdbc:(db2|informix-sqli|gbasedbt-sqli):/.test(url)) return { ...LITERAL_PARAMETER_SYNTAX, leadingColon: true };
  if (["exasol", "bigquery", "spanner"].includes(context.db_type) || url.startsWith("jdbc:exa:") || /^jdbc:(dremio|phoenix):/.test(url)) return LITERAL_PARAMETER_SYNTAX;
  // Oracle Go uses url.ParseQuery even in OCI mode; Oracle JDBC Easy Connect uses literal values.
  if (url.startsWith("jdbc:oracle:") || context.driver_profile === "oceanbase-oracle") return { separator: "&", encoding: "literal" };
  return QUERY_PARAMETER_SYNTAX;
}

export function connectionParameterCatalog(context: ConnectionParameterContext): ConnectionParameterDefinition[] {
  switch (context.db_type) {
    case "mysql": {
      const profile = context.driver_profile?.trim().toLowerCase() ?? "";
      // ConnectionConfig::needs_bare_mysql() routes these profiles through a fixed
      // Compatible setup mode. URL normalization also drops charset and may force
      // cleartext authentication; advertising those as overrides would be misleading.
      const bare = ["doris", "selectdb", "starrocks", "oceanbase", "manticoresearch"].includes(profile);
      return [
        ...MYSQL_PARAMETERS.filter((definition) => {
          if (definition.name === "dataCharset" && profile && profile !== "mysql") return false;
          if (bare && ["charset", "dataCharset", "setupMode", "proxysql", "enable_cleartext_plugin"].includes(definition.name)) return false;
          if (bare && definition.managedBy === "tls" && !["doris", "starrocks"].includes(profile)) return false;
          return true;
        }),
        ...(["doris", "selectdb", "starrocks"].includes(profile) ? [param("catalog", "string", "External catalog selected before the database.", "进入数据库前切换的外部 Catalog。")] : []),
      ];
    }
    case "postgres":
    case "redshift":
      return [...POSTGRES_PARAMETERS];
    case "oracle":
      return context.driver_profile === "oci" ? [] : [...ORACLE_PARAMETERS];
    case "sqlserver":
      return context.driver_profile?.includes("legacy")
        ? []
        : [param("sqlserverEncryption", "enum", "Encryption setting for DBX's native SQL Server transport. Omit to use automatic negotiation.", "DBX 原生 SQL Server 驱动的加密设置；不配置时自动协商。", { choices: ["disabled"], aliases: ["encrypt"], managedBy: "tls" })];
    case "redis":
      return [param("insecure", "boolean", "Disable verification of the TLS certificate.", "禁用 TLS 证书验证。", { aliases: ["tls_insecure", "accept_invalid_certs"], managedBy: "tls" })];
    case "sqlite":
      return [param("sqlite_extension", "file", "An explicitly configured SQLite extension to load.", "明确指定要加载的 SQLite 扩展。", { repeatable: true })];
    default:
      return [];
  }
}

export function parameterDefinitionForKey(definitions: readonly ConnectionParameterDefinition[], key: string): ConnectionParameterDefinition | undefined {
  const normalized = key.trim().toLowerCase();
  return definitions.find((definition) => definition.name.toLowerCase() === normalized || definition.aliases?.some((alias) => alias.toLowerCase() === normalized));
}

/** Only newly edited values are validated; legacy overrides remain editable without silent changes. */
export function parameterValueError(definition: ConnectionParameterDefinition | undefined, value: string): "integer" | "boolean" | "choice" | null {
  if (!definition) return null;
  if (definition.type === "integer") {
    const number = Number(value);
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(number) || (definition.min !== undefined && number < definition.min) || (definition.max !== undefined && number > definition.max)) return "integer";
  }
  if (definition.type === "boolean" && !["true", "false", "1", "0", "yes", "no", "on", "off"].includes(value.toLowerCase())) return "boolean";
  if (definition.choices && !definition.choices.some((choice) => choice.toLowerCase() === value.toLowerCase())) return "choice";
  return null;
}
