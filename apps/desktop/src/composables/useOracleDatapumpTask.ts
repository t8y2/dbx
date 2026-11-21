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
// 对话框状态（给常驻药丸组件判断：对话框打开且非最小化时，隐藏正在展示的任务）。
const dialogOpen = ref(false);
const dialogMinimized = ref(false);
// 最小化时保存的表单状态（没开始任务就最小化 → 点药丸恢复配置）。
const formMinimized = ref(false);
const savedForm = ref<Record<string, string> | null>(null);

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
        // 药丸绝不自动关闭：无论成功/失败/取消，都由用户手动关闭。
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
    dialogOpen.value = false;
    dialogMinimized.value = false;
    formMinimized.value = false;
    savedForm.value = null;
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
    dialogOpen,
    dialogMinimized,
    formMinimized,
    savedForm,
    begin,
    cancel,
    dismiss,
    reset,
    focusTask,
    openResult,
    openConfigure,
  };
}
