import { invoke } from "@tauri-apps/api/core";

/**
 * PL/SQL 调试（Oracle）。
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

/**
 * One entry of the call stack the agent derived from DBMS_DEBUG's
 * PRINT_BACKTRACE listing.
 *
 * The array is ordered innermost first: `frames[0]` is the frame the debuggee is
 * parked in, which is why the frame's **array index** — not `stackDepth` — is the
 * frame number `DBMS_DEBUG.GET_VALUES` expects. `stackDepth` counts from the
 * outermost frame instead (the agent numbers frames[0] with the largest depth).
 */
export interface PlDebugFrame {
  /** Depth counted from the outermost frame (1 = outermost/entry), when known. */
  stackDepth?: number | null;
  /** 1-based source line of the frame, or null/0 when the server reported none. */
  line?: number | null;
  /**
   * Program identifier of the frame: the routine name, or the package name when
   * the frame runs inside a package member (see `programOwner`). The agent never
   * puts source text here — that goes to `source`.
   */
  program?: string | null;
  /** Owner of `program` for a package member; absent when the server did not report it. */
  programOwner?: string | null;
  /**
   * Source text of the frame's line. Oracle prints the source line where a frame
   * name would go, so the agent keeps it in its own field; it may be absent when
   * the server printed fewer lines than the listing has frames.
   */
  source?: string | null;
}

/**
 * One OUT / IN OUT parameter of the debugged routine, captured when the target
 * runs to completion (see `PlDebugStatus.outParams`).
 */
export interface PlDebugOutParam {
  name: string;
  /** `OUT` | `IN OUT` */
  mode: string;
  type: string;
  value: string;
}

/** Function return value, captured when the debugged function runs to completion. */
export interface PlDebugReturnValue {
  type?: string | null;
  value?: string | null;
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
  /**
   * Structured call stack, innermost frame first (see `PlDebugFrame`). Always an
   * array in `pl_debug_get_stack` responses, so the stack panel needs no nil check.
   */
  frames?: PlDebugFrame[];
  /**
   * The debuggee is parked because it raised (or is handling) an exception rather
   * than because it hit a breakpoint (`reason` is DBMS_DEBUG's exception/handler).
   */
  stoppedOnException?: boolean;
  /**
   * The exception-breakpoint resume loop hit its continuation cap without seeing
   * an exception, so it stopped rather than polling forever; `message` carries the
   * agent's explanation. Not an error: the session is still usable.
   */
  exceptionResumeTruncated?: boolean;
  /**
   * OUT / IN OUT parameter values of the completed target. Only present once the
   * target ran to completion (never while it is parked), so an empty/absent array
   * means "not finished yet" rather than "no OUT parameters".
   */
  outParams?: PlDebugOutParam[];
  /** Return value of the completed target; only present for a function that finished. */
  returnValue?: PlDebugReturnValue | null;
}

export async function plDebugProbe(connectionId: string): Promise<PlDebugProbeResult> {
  return invoke("pl_debug_probe", { connectionId });
}

export async function plDebugStart(connectionId: string, database: string, request: PlDebugStartRequest): Promise<PlDebugStatus> {
  return invoke("pl_debug_start", { connectionId, database, request });
}

/**
 * 断点增删的返回体在两种 agent 下形状不同：Java（oceanbase-oracle，现居
 * `feature/ob-oracle-pl-debug` 分支）回 `{ok, breakpoints}`，Go（oracle）直接回
 * 数组。调用方只关心断点列表，这里统一摊平成数组，避免两种后端下 store 的本地
 * 缓存一个有一个没有。
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
