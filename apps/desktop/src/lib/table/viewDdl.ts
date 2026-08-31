import type { DatabaseType } from "@/types/database";
import * as api from "@/lib/backend/api";

export type BuildViewDdlInput = {
  databaseType?: DatabaseType;
  schema?: string | null;
  name: string;
  source: string;
  /** Driver-reported identifier quote (e.g. `` ` `` for Kingbase MySQL compat). */
  identifierQuote?: string;
};

export function buildViewDdl(input: BuildViewDdlInput): Promise<string> {
  return api.buildViewDdlSql(input);
}
