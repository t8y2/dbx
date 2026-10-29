import { patchConnectionParameter } from "@/lib/connection/connectionParameterDocument";
const MYSQL_CLEAR_TEXT_PARAM_ALIASES = new Set(["allowcleartextpasswords", "enable_cleartext_plugin"]);
const MYSQL_CLEAR_TEXT_PARAM = "enable_cleartext_plugin";

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

function isTruthyUrlParam(value: string): boolean {
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

function isMysqlCleartextPasswordParam(key: string): boolean {
  return MYSQL_CLEAR_TEXT_PARAM_ALIASES.has(normalizeKey(key));
}

export function mysqlCleartextPasswordAuthEnabled(params: string | undefined): boolean {
  const parsed = new URLSearchParams((params || "").trim().replace(/^\?/, ""));
  for (const [key, value] of parsed.entries()) {
    if (isMysqlCleartextPasswordParam(key) && isTruthyUrlParam(value)) return true;
  }
  return false;
}

export function setMysqlCleartextPasswordAuthEnabled(params: string | undefined, enabled: boolean): string {
  return patchConnectionParameter(params, MYSQL_CLEAR_TEXT_PARAM, enabled ? "true" : null, { aliases: Array.from(MYSQL_CLEAR_TEXT_PARAM_ALIASES), caseInsensitive: true });
}
