import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/api";
import type { ConnectionConfig } from "@/types/database";

const DB_EXTENSIONS = [".db", ".sqlite", ".sqlite3", ".duckdb"];

function getDbType(path: string): "sqlite" | "duckdb" | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".duckdb")) return "duckdb";
  if (DB_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "sqlite";
  return null;
}

function getDataFileQuery(path: string): string | null {
  const lower = path.toLowerCase();
  const escaped = path.replace(/'/g, "''");
  if (lower.endsWith(".parquet")) return `SELECT * FROM read_parquet('${escaped}') LIMIT 1000`;
  if (lower.endsWith(".csv")) return `SELECT * FROM read_csv('${escaped}') LIMIT 1000`;
  if (lower.endsWith(".tsv")) return `SELECT * FROM read_csv('${escaped}', delim='\\t') LIMIT 1000`;
  if (lower.endsWith(".json")) return `SELECT * FROM read_json('${escaped}') LIMIT 1000`;
  return null;
}

export function useFileDrop() {
  const { t } = useI18n();
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();
  const { toast } = useToast();

  async function setupFileDrop() {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const webview = getCurrentWebview();
    await webview.onDragDropEvent(async (event) => {
      if (event.payload.type !== "drop") return;
      for (const path of event.payload.paths) {
        const name = path.split("/").pop()?.split("\\").pop() || path;

        const dataQuery = getDataFileQuery(path);
        if (dataQuery) {
          const config: ConnectionConfig = {
            id: crypto.randomUUID(),
            name: `[Preview] ${name}`,
            db_type: "duckdb",
            driver_profile: "duckdb",
            driver_label: "DuckDB",
            url_params: "",
            host: ":memory:",
            port: 0,
            username: "",
            password: "",
          };
          const connectionId = await api.connectDb(config);
          connectionStore.addEphemeralConnection({ ...config, id: connectionId });
          const tabId = queryStore.createTab(connectionId, "", name, "query");
          queryStore.updateSql(tabId, dataQuery);
          queryStore.executeCurrentTab();
          toast(t("welcome.fileOpened", { name }));
          continue;
        }

        const dbType = getDbType(path);
        if (!dbType) continue;
        const config: ConnectionConfig = {
          id: crypto.randomUUID(),
          name,
          db_type: dbType,
          driver_profile: dbType,
          driver_label: dbType === "duckdb" ? "DuckDB" : "SQLite",
          url_params: "",
          host: path,
          port: 0,
          username: "",
          password: "",
        };
        try {
          await connectionStore.addConnection(config);
          void connectionStore.connect(config);
          toast(t("welcome.fileOpened", { name }));
        } catch (e: any) {
          toast(t("connection.saveFailed", { message: e?.message || String(e) }), 5000);
        }
      }
    });
  }

  return { setupFileDrop };
}
