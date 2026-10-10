import { invoke } from "@tauri-apps/api/core";

/**
 * PL/SQL 调试（OceanBase Oracle 模式）。
 *
 * 后端由 Java agent 的双连接（debuggee + debugger）与 DBMS_DEBUG 承载；
 * 这里的接口一一对应 Tauri 命令。resume/step/abort 为阻塞调用：它们直到
 * 程序在下一次停止点挂起才返回，界面在等待期间应保持按钮忙碌态。
 */

/**
 * Capability report of one connection.
 *
 * `supported` answers only "can this server be debugged at all". A server can be
 * fully debuggable and still lack DBMS_DEBUG.GET_VALUES (stock Oracle 21c XE
 * declares GET_VALUE only): breakpoints, stepping and the backtrace work, but
 * `get_variables` cannot return anything. That partial state is reported by
 * `variablesSupported`, which is a separate axis from `supported` — conflating
 * the two would disable the whole debugger for a server that only lacks
 * variable inspection.
 */
export interface PlDebugProbeResult {
  supported: boolean;
  dbmsDebug?: boolean;
  dbmsOutput?: boolean;
  /** Whether DBMS_DEBUG.GET_VALUES exists, i.e. the variables panel can work. */
  variablesSupported?: boolean;
  /** Required DBMS_DEBUG subroutines the server does not expose. */
  missingProcedures?: string[];
  /** Optional subroutines the server does not expose (degrades one feature each). */
  missingOptionalProcedures?: string[];
  /** Backend-authored explanation; display it verbatim, never re-authored here. */
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

/**
 * 断点增删的返回体在两种 agent 下形状不同：Java（oceanbase-oracle）回
 * `{ok, breakpoints}`，Go（oracle）直接回数组。调用方只关心断点列表，这里统一
 * 摊平成数组，避免两种后端下 store 的本地缓存一个有一个没有。
 */
function normalizeBreakpointResponse(response: unknown): PlDebugBreakpoint[] {
  if (Array.isArray(response)) return response as PlDebugBreakpoint[];
  const wrapped = (response as { breakpoints?: unknown } | null)?.breakpoints;
  return Array.isArray(wrapped) ? (wrapped as PlDebugBreakpoint[]) : [];
}

export async function plDebugSetBreakpoints(debugId: string, breakpoints: PlDebugBreakpoint[]): Promise<PlDebugBreakpoint[]> {
  return normalizeBreakpointResponse(await invoke("pl_debug_set_breakpoints", { debugId, breakpoints }));
}

export async function plDebugDeleteBreakpoints(debugId: string, breakpoints: PlDebugBreakpoint[]): Promise<PlDebugBreakpoint[]> {
  return normalizeBreakpointResponse(await invoke("pl_debug_delete_breakpoints", { debugId, breakpoints }));
}

export async function plDebugListBreakpoints(debugId: string): Promise<PlDebugBreakpoint[]> {
  return invoke("pl_debug_list_breakpoints", { debugId });
}

/**
 * `pl_debug_set_breakpoint_enabled` 的返回体：在服务端原地开关一个已存在的
 * 断点（DBMS_DEBUG ENABLE_BREAKPOINT / DISABLE_BREAKPOINT），不再删除重设。
 *
 * `serverSupported = false` 是能力哨兵而非错误：服务器没有该原语，调用方应回退到
 * 客户端兜底路径（删除 + 重设）。`result = 0` 表示成功，非 0 时 `message` 由后端
 * 写明原因（例如断点号不存在 error_no_such_breakpt），前端原样展示、不要改写。
 */
export interface PlDebugBreakpointEnabledResult {
  ok: boolean;
  result: number;
  /** 服务器是否提供 enable/disable 原语；false 时前端必须走兜底路径。 */
  serverSupported: boolean;
  /** 后端作者的说明（断点号不存在 / 不支持原语），原样展示。 */
  message?: string;
  breakpointNumber?: number | null;
  enabled?: boolean;
}

/** 原地开关一个已存在的服务端断点；`serverSupported = false` 时回退到删除 + 重设。 */
export async function plDebugSetBreakpointEnabled(debugId: string, breakpointNumber: number, enabled: boolean): Promise<PlDebugBreakpointEnabledResult> {
  return invoke("pl_debug_set_breakpoint_enabled", { debugId, breakpointNumber, enabled });
}

/**
 * DBMS_DEBUG.SET_VALUE：修改变量/参数的值。frame/index 分别定位栈帧与同名
 * 变量展开项的下标（复合类型字段），两者省略时后端按 0 处理。
 */
export async function plDebugSetValue(debugId: string, name: string, frame: number, index: number, value: string): Promise<PlDebugStatus> {
  return invoke("pl_debug_set_value", { debugId, name, frame, index, value });
}

/** 异常断点开关：开启后调试器在任何异常抛出点挂起。 */
export async function plDebugSetExceptionBreakpoint(debugId: string, enabled: boolean): Promise<PlDebugStatus> {
  return invoke("pl_debug_set_exception_breakpoint", { debugId, enabled });
}

export async function plDebugResume(debugId: string): Promise<PlDebugStatus> {
  return invoke("pl_debug_resume", { debugId });
}

/** 忽略断点运行到结束（ODC 的 resumeIgnoreBreakpoints）。阻塞调用，直到解释器退出。 */
export async function plDebugResumeIgnoreBreakpoints(debugId: string): Promise<PlDebugStatus> {
  return invoke("pl_debug_resume_ignore_breakpoints", { debugId });
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

export async function plDebugGetVariables(debugId: string, frame = 0): Promise<PlDebugStatus> {
  return invoke("pl_debug_get_variables", { debugId, frame });
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
