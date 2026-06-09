import type { ConnectionConfig } from "@/types/database";

export type H2ConnectionMode = "file" | "tcp";

const H2_FILE_PREFIX = "jdbc:h2:file:";

export function isH2FileJdbcUrl(value: string | undefined | null): boolean {
  return (value || "").trim().toLowerCase().startsWith(H2_FILE_PREFIX);
}

export function h2FilePathFromJdbcUrl(value: string | undefined | null): string {
  const trimmed = (value || "").trim();
  if (!isH2FileJdbcUrl(trimmed)) return "";
  return trimmed.slice(H2_FILE_PREFIX.length).split(";")[0] || "";
}

export function h2JdbcFileBasePath(path: string): string {
  const trimmed = path.trim();
  if (/\.mv\.db$/i.test(trimmed)) return trimmed.slice(0, -".mv.db".length);
  if (/\.h2\.db$/i.test(trimmed)) return trimmed.slice(0, -".h2.db".length);
  return trimmed;
}

export function h2FileJdbcUrl(path: string): string {
  return `${H2_FILE_PREFIX}${h2JdbcFileBasePath(path)};AUTO_SERVER=TRUE`;
}

export function h2ConnectionModeForConfig(config: Pick<ConnectionConfig, "db_type" | "connection_string" | "port">) {
  if (config.db_type !== "h2") return "tcp";
  return isH2FileJdbcUrl(config.connection_string) || config.port === 0 ? "file" : "tcp";
}
