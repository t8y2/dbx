import type { SqlFileProgress } from "./tauri";
import { apiUrl } from "@/lib/webPath";

export function listenSqlFileProgressById(executionId: string, handler: (progress: SqlFileProgress) => void): () => void {
  const es = new EventSource(apiUrl(`/api/sql-file/progress/${executionId}`));
  es.onmessage = (e) => {
    const progress: SqlFileProgress = JSON.parse(e.data);
    handler(progress);
    if (progress.status === "done" || progress.status === "error" || progress.status === "cancelled") {
      es.close();
    }
  };
  es.onerror = () => {
    es.close();
  };
  return () => es.close();
}
