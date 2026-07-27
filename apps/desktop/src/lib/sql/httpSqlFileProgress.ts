import type { SqlFileProgress } from "@/lib/backend/tauri";
import { apiUrl } from "@/lib/common/webPath";

export function listenSqlFileProgressById(executionId: string, handler: (progress: SqlFileProgress) => void, onError?: (error: Error) => void): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const es = new EventSource(apiUrl(`/api/sql-file/progress/${executionId}`));
    let opened = false;
    const close = () => es.close();

    es.onopen = () => {
      opened = true;
      resolve(close);
    };
    es.onmessage = (e) => {
      const progress: SqlFileProgress = JSON.parse(e.data);
      handler(progress);
      if (progress.status === "done" || progress.status === "error" || progress.status === "cancelled") {
        close();
      }
    };
    es.onerror = () => {
      close();
      const error = new Error("SQL file progress connection failed");
      if (opened) {
        onError?.(error);
      } else {
        reject(error);
      }
    };
  });
}
