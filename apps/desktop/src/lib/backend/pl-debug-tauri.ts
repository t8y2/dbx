import { invoke } from "@tauri-apps/api/core";

/**
 * PL/SQL 调试（OceanBase Oracle 模式）。
 *
 * 后端由 Java agent 的双连接（debuggee + debugger）与 DBMS_DEBUG 承载；
 * 这里的接口一一对应 Tauri 命令。resume/step/abort 为阻塞调用：它们直到
 * 程序在下一次停止点挂起才返回，界面在等待期间应保持按钮忙碌态。
 */

export interface PlDebugProbeResult {
  supported: boolean;
  dbmsDebug?: boolean;
  dbmsOutput?: boolean;
  reason?: string;
}

export interface PlDebugParam {
  name: string;
  /** IN | OUT | IN OUT */
  mode: string;
  type: string;
  value?: string | null;
}

export interface PlDebugStartRequest {
  schema?: string | null;
  /** PROCEDURE | FUNCTION | ANONYMOUS */
  objectType: string;
  objectName?: string | null;
  packageName?: string | null;
  /** 匿名块源码（objectType = ANONYMOUS 时必填） */
  source?: string | null;
  params?: PlDebugParam[];
}

export interface PlDebugBreakpoint {
  owner?: string | null;
  name?: string | null;
  line?: number | null;
  breakpointNumber?: number | null;
  /** PROCEDURE | FUNCTION | ANONYMOUS */
  kind?: string | null;
}

export interface PlDebugStatus {
  debugId?: string;
  owner?: string;
  terminated?: boolean;
  line?: string | null;
  program?: string | null;
  programOwner?: string | null;
  breakpoint?: number | null;
  reason?: number | null;
  stackDepth?: number | null;
  error?: string | null;
  expired?: boolean;
  message?: string;
  /** DBMS_DEBUG.GET_VALUES 的原始 JSON 文本（OceanBase）或 `*name*type*value` 文本（Oracle） */
  scalarValues?: string;
  /** 后端统一解析后的变量列表（两种格式都已摊平） */
  variables?: Array<{ name: string; value: string; type?: string }>;
  backtrace?: string;
  dbmsStatus?: number;
  output?: string;
}

export async function plDebugProbe(connectionId: string): Promise<PlDebugProbeResult> {
  return invoke("pl_debug_probe", { connectionId });
}

export async function plDebugStart(connectionId: string, database: string, request: PlDebugStartRequest): Promise<PlDebugStatus> {
  return invoke("pl_debug_start", { connectionId, database, request });
}

export async function plDebugSetBreakpoints(debugId: string, breakpoints: PlDebugBreakpoint[]): Promise<{ ok: boolean; breakpoints: PlDebugBreakpoint[] }> {
  return invoke("pl_debug_set_breakpoints", { debugId, breakpoints });
}

export async function plDebugDeleteBreakpoints(debugId: string, breakpoints: PlDebugBreakpoint[]): Promise<{ ok: boolean; breakpoints: PlDebugBreakpoint[] }> {
  return invoke("pl_debug_delete_breakpoints", { debugId, breakpoints });
}

export async function plDebugListBreakpoints(debugId: string): Promise<PlDebugBreakpoint[]> {
  return invoke("pl_debug_list_breakpoints", { debugId });
}

export async function plDebugResume(debugId: string): Promise<PlDebugStatus> {
  return invoke("pl_debug_resume", { debugId });
}

export async function plDebugStepOver(debugId: string): Promise<PlDebugStatus> {
  return invoke("pl_debug_step_over", { debugId });
}

export async function plDebugStepIn(debugId: string): Promise<PlDebugStatus> {
  return invoke("pl_debug_step_in", { debugId });
}

export async function plDebugStepOut(debugId: string): Promise<PlDebugStatus> {
  return invoke("pl_debug_step_out", { debugId });
}

export async function plDebugAbort(debugId: string): Promise<PlDebugStatus> {
  return invoke("pl_debug_abort", { debugId });
}

export async function plDebugGetVariables(debugId: string): Promise<PlDebugStatus> {
  return invoke("pl_debug_get_variables", { debugId });
}

export async function plDebugGetStack(debugId: string): Promise<PlDebugStatus> {
  return invoke("pl_debug_get_stack", { debugId });
}

export async function plDebugGetLog(debugId: string): Promise<PlDebugStatus> {
  return invoke("pl_debug_get_log", { debugId });
}

export async function plDebugClose(debugId: string): Promise<void> {
  return invoke("pl_debug_close", { debugId });
}

/**
 * 把 agent 透传的 scalar_values JSON 文本摊平成 name → value 列表。
 *
 * OceanBase 的 `DBMS_DEBUG.GET_VALUES` 输出是 JSON（结构随版本可能不同），
 * 这里做宽松处理：对象按点号路径展开，数组按 [i] 展开，标量直接取值；
 * 解析失败时退化为单条原始文本，保证面板永远有内容可展示。
 */
export function parsePlDebugVariables(scalarValues: string | null | undefined): Array<{ name: string; value: string }> {
  const payload = (scalarValues ?? "").trim();
  if (!payload) return [];
  const collected: Array<{ name: string; value: string }> = [];
  const walk = (value: unknown, prefix: string | null): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, prefix === null ? `[${index}]` : `${prefix}[${index}]`));
      return;
    }
    if (typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        walk(nested, prefix === null ? key : `${prefix}.${key}`);
      }
      return;
    }
    collected.push({ name: prefix ?? "value", value: String(value) });
  };
  try {
    walk(JSON.parse(payload), null);
    return collected;
  } catch {
    return [{ name: "values", value: payload }];
  }
}
