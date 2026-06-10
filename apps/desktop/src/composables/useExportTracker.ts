import { reactive, computed } from "vue";
import * as api from "@/lib/api";

export interface ExportTask {
  exportId: string;
  tableName: string;
  format: "csv" | "xlsx";
  filePath: string;
  rowsExported: number;
  totalRows: number | null;
  status: string;
  errorMessage: string | null;
}

const taskMap = reactive<Map<string, ExportTask>>(new Map());

export function useExportTracker() {
  const tasks = computed(() => Array.from(taskMap.values()));

  const activeCount = computed(() => tasks.value.filter((t) => t.status === "Running" || t.status === "Writing").length);

  const hasActive = computed(() => activeCount.value > 0);

  function addTask(tableName: string, format: "csv" | "xlsx", filePath: string): ExportTask {
    const exportId = crypto.randomUUID();
    const task = reactive<ExportTask>({
      exportId,
      tableName,
      format,
      filePath,
      rowsExported: 0,
      totalRows: null,
      status: "Running",
      errorMessage: null,
    });
    taskMap.set(exportId, task);
    return task;
  }

  function removeTask(exportId: string) {
    taskMap.delete(exportId);
  }

  function clearFinished() {
    for (const [id, task] of taskMap) {
      if (task.status === "Done" || task.status === "Error" || task.status === "Cancelled") {
        taskMap.delete(id);
      }
    }
  }

  async function cancelTask(exportId: string) {
    try {
      await api.cancelTableExport(exportId);
    } catch {
      // ignore
    }
  }

  return {
    tasks,
    activeCount,
    hasActive,
    addTask,
    removeTask,
    clearFinished,
    cancelTask,
  };
}
