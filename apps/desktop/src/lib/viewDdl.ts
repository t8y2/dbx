import type { DatabaseType } from "@/types/database";
import * as api from "@/lib/api";

export type BuildViewDdlInput = {
  databaseType?: DatabaseType;
  schema?: string | null;
  name: string;
  source: string;
};

export function buildViewDdl(input: BuildViewDdlInput): Promise<string> {
  return api.buildViewDdlSql(input);
}
