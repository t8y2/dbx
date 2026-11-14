import { ref } from "vue";
import * as api from "@/lib/backend/api";
import type { OracleDatapumpKind, OracleDatapumpProgress, OracleDatapumpRequest } from "@/lib/backend/oracleDatapumpTypes";
import { uuid } from "@/lib/common/utils";

// 数据泵任务状态（模块级单例）：支持多任务并发。
// 对话框可以随意重置/重开；每个运行中的任务独立持有进度。

export interface OracleDatapumpTaskState {
  taskId: string;
  connectionId: string;
  database: string;
  kind: OracleDatapumpKind;
  directory: string;
  dumpfile: string;
  progress: OracleDatapumpProgress | null;
  running: boolean;
  error: string | null;
}

const tasks = ref<OracleDatapumpTaskState[]>([]);
// 对话框当前应显示哪个任务（药丸点击设置；新配置设为 null = 新任务）。
const activeTaskId = ref<string | null>(null);
// 对话框当前应显示的页面。
const viewMode = ref<"configure" | "result">("configure");

export function useOracleDatapumpTask() {
  function begin(request: Omit<OracleDatapumpRequest, "taskId">): void {
    const taskId = uuid();
    const task: OracleDatapumpTaskState = {
      taskId,
      connectionId: request.connectionId,
      database: request.database,
      kind: request.kind,
      directory: request.directory,
      dumpfile: request.dumpfile,
      progress: null,
      running: true,
      error: null,
    };
    tasks.value.push(task);
    activeTaskId.value = taskId;
    void api
      .startOracleDatapump({ ...request, taskId }, (value) => {
        const t = tasks.value.find((t) => t.taskId === taskId);
        if (t) t.progress = value;
      })
      .then((progress) => {
        const t = tasks.value.find((t) => t.taskId === taskId);
        if (!t) return;
        t.progress = progress;
        t.running = false;
        // 顺利收尾 6 秒后从列表移除；出错保留等人看。
        if (progress.status === "Done" || progress.status === "Cancelled") {
          setTimeout(() => {
            tasks.value = tasks.value.filter((t) => t.taskId !== taskId);
          }, 6000);
        }
      })
      .catch((cause) => {
        const t = tasks.value.find((t) => t.taskId === taskId);
        if (!t) return;
        t.running = false;
        t.error = String(cause instanceof Error ? cause.message : cause);
      });
  }

  async function cancel(taskId: string): Promise<void> {
    await api.cancelOracleDatapump(taskId);
  }

  function dismiss(taskId: string): void {
    tasks.value = tasks.value.filter((t) => t.taskId !== taskId);
    if (activeTaskId.value === taskId) activeTaskId.value = null;
  }

  function focusTask(taskId: string | null): void {
    activeTaskId.value = taskId;
    viewMode.value = taskId ? "result" : "configure";
  }

  function reset(): void {
    tasks.value = [];
    activeTaskId.value = null;
    viewMode.value = "configure";
  }

  function openResult(): void {
    viewMode.value = "result";
  }

  function openConfigure(): void {
    viewMode.value = "configure";
    activeTaskId.value = null;
  }

  return {
    tasks,
    activeTaskId,
    viewMode,
    begin,
    cancel,
    dismiss,
    reset,
    focusTask,
    openResult,
    openConfigure,
  };
}
