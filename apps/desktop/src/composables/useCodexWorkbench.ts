import { apiUrl } from "@/lib/common/webPath";
import type { QueryResult } from "@/types/database";
import type { NavigationTarget } from "@/composables/useNavigationTargets";

type Intent = {
  kind: "table" | "result";
  connection_id: string;
  database: string;
  schema?: string;
  table?: string;
  sql?: string;
  results?: QueryResult[];
};

async function readIntent(id: string): Promise<Intent> {
  const response = await fetch(apiUrl(`/codex/intents/${encodeURIComponent(id)}`), { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 404 ? "Workbench link expired or unavailable" : "Unable to open Codex workbench link");
  return response.json();
}

export function createCodexIntentHandler(actions: {
  read?: (id: string) => Promise<Intent>;
  openTable: (target: NavigationTarget) => Promise<unknown>;
  showResults: (connectionId: string, database: string, sql: string, results: QueryResult[]) => unknown;
}) {
  const handled = new Set<string>();
  return async (url: string) => {
    const id = new URL(url).searchParams.get("codex_intent");
    if (!id || handled.has(id)) return;
    handled.add(id);
    try {
      const intent = await (actions.read ?? readIntent)(id);
      if (intent.kind === "table" && intent.table) {
        await actions.openTable({ connectionId: intent.connection_id, database: intent.database, schema: intent.schema, tableName: intent.table });
      } else if (intent.kind === "result" && intent.sql && Array.isArray(intent.results)) {
        actions.showResults(intent.connection_id, intent.database, intent.sql, intent.results);
      } else {
        throw new Error("Invalid Codex workbench link");
      }
    } catch (error) {
      handled.delete(id);
      throw error;
    }
  };
}
