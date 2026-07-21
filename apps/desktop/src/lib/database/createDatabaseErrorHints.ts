import type { DatabaseType } from "@/types/database";

type Translate = (key: string) => string;

function isMysqlCreateDatabaseAccessDenied(message: string): boolean {
  return /\b1044\b/i.test(message) || /access denied for user[\s\S]*to database/i.test(message);
}

export function appendCreateDatabaseErrorHint(databaseType: DatabaseType | undefined, message: string, t: Translate): string {
  if (databaseType !== "mysql" || !isMysqlCreateDatabaseAccessDenied(message)) return message;
  const hint = t("contextMenu.mysqlCreateDatabasePermissionHint");
  return message.includes(hint) ? message : `${message}\n\n${hint}`;
}
