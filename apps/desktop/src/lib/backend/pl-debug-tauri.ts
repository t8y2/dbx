import { invoke } from "@tauri-apps/api/core";
import type { PlDebugTargetSignature } from "@/lib/debug/plDebugProtocol";
import type { CompositeRoot } from "@/lib/debug/plDebugComposite";

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
  capabilities?: Record<string, { status?: string; canAttempt?: boolean; evidence?: string }>;
  dbmsDebug?: boolean;
  dbmsOutput?: boolean;
  /**
   * Whether the variables panel can show values at all. Two server shapes count:
   * `GET_VALUES` (OceanBase Oracle mode: one call lists the whole frame) and stock
   * Oracle's `GET_VALUE`, where the agent enumerates the names it can see (parameters +
   * source declarations) and reads each one -- see `variablesFallback`.
   */
  variablesSupported?: boolean;
  /**
   * "get_value" when the variables come from the one-name-per-call fallback: the panel
   * then notes that only scalars the source declares are visible (compound types and
   * collections are not).
   */
  variablesFallback?: string;
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
  typedValue?:
    | { kind: "number" | "text" | "date" | "timestamp" | "clob" | "nclob" | "binary_float" | "binary_double"; value: string }
    | { kind: "boolean"; value: boolean }
    | { kind: "timestamp_tz"; value: { local: string; offset: string; region: string | null } }
    | { kind: "timestamp_ltz"; value: { instant: string } }
    | { kind: "blob" | "raw"; value: { encoding: "base64"; data: string } }
    | CompositeRoot;
  inputState?: "value" | "null" | "default";
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
  targetSignature?: PlDebugTargetSignature;
  metadataPreparation?: "type_only";
}

export interface PlDebugBreakpoint {
  ignoreCount?: number;
  condition?: string;
  message?: string;
  hits?: number;
  owned?: boolean;
  registrationId?: string;
  sourceRefId?: string;
  sourceRevision?: number;
  nativeLine?: number | null;
  localActive?: boolean;
  owner?: string | null;
  name?: string | null;
  line?: number | null;
  breakpointNumber?: number | null;
  /** PROCEDURE | FUNCTION | ANONYMOUS */
  kind?: string | null;
}

export interface PlDebugSourceRef {
  id: string;
  sourceRevision: number;
  stopRevision: number;
  nativeFrameId: number;
  lineBasis: string;
  identityState: string;
  evidenceKind: string;
  objectType: string;
  source: string;
  lineOffset?: number;
  owner?: string | null;
  name?: string | null;
  objectId?: string | null;
  namespace?: number | null;
}

/** The Agent orders frames innermost first; native frame IDs remain engine-owned. */
export interface PlDebugFrame {
  frameIndex?: number;
  nativeFrameId?: number;
  sourceState?: string;
  sourceRef?: PlDebugSourceRef | null;
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
export interface PlDebugResultReference {
  generation: string;
  resultId: string;
  encoding: "utf16" | "base64";
  length: number;
  lengthUnit: "utf16" | "bytes";
  complete: boolean;
  truncated: boolean;
  state: "available" | "partial";
  error?: string;
  errorPath?: string;
}

export interface PlDebugOutParam {
  name: string;
  /** `OUT` | `IN OUT` */
  mode: string;
  type: string;
  value: string | null;
  resultRef?: PlDebugResultReference;
  state?: string;
}

/** Function return value, captured when the debugged function runs to completion. */
export interface PlDebugReturnValue {
  type?: string | null;
  value?: string | null;
  resultRef?: PlDebugResultReference;
  state?: string;
}

export interface PlDebugStatus {
  exceptionBreakpoint?: boolean;
  capabilities?: Record<string, { status?: string; canAttempt?: boolean; message?: string; evidence?: string }>;
  breakpointRulesOwner?: "agent";
  breakpointRuleEvents?: Array<{ sequence: number; stopRevision: number; breakpointNumber: number; message?: string; warning?: string }>;
  sourceRef?: PlDebugSourceRef | null;
  sourceMappingState?: string;
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
  frameMappingState?: string;
  /**
   * The debuggee is parked because it raised (or is handling) an exception rather
   * than because it hit a breakpoint (`reason` is DBMS_DEBUG's exception/handler).
   */
  stoppedOnException?: boolean;
  /**
   * 超时后 DBMS_DEBUG 对目标做的事（`SET_TIMEOUT_BEHAVIOUR`）：2 = `nodebug_on_timeout`
   * （超时即调用 `debug_off` 让程序退出调试继续跑），0 = 未知/未设置（服务器默认
   * `continue_on_timeout`）。diagnostic 字段，界面不显示。
   */
  timeoutBehaviour?: number | null;
  /**
   * The exception-breakpoint resume loop hit its continuation cap without seeing
   * an exception, so it stopped rather than polling forever; `message` carries the
   * agent's explanation. Not an error: the session is still usable.
   */
  exceptionResumeTruncated?: boolean;
  /**
   * agent 在 step_in 实际没进入子程序时给出的解释（可能包含「本行没有可进入的调用」
   * 这种正常情形）；文本由后端作者撰写，前端原样记录，不改写。
   */
  stepHint?: string;
  /**
   * `resumeIgnoreBreakpoints` 没能跑到结束（有断点禁不掉或续跑次数到顶），
   * `message` 带原因；此时程序是"停住"而非"跑完"。
   */
  runToEndIncomplete?: boolean;
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
 * SET_VALUE 的 agent 响应信封。与 step/resume 的扁平 `PlDebugStatus` 不同，这一层包装
 * 不会在 Rust 侧摊平：实机（19c）响应是 `{ok, result, message, assignmentSemicolon,
 * snapshot}`，停止位置（`reason` 等）只在 `snapshot` 里，顶层没有这些字段。
 */
export interface PlDebugSetValueResult {
  ok?: boolean;
  /** DBMS_DEBUG.SET_VALUE 的返回码（0 = success）。 */
  result?: number;
  /** 可直接记录的说明（例如“补了结尾分号后重试成功”）。 */
  message?: string;
  /** 赋值补上结尾分号后才成功：DBMS_DEBUG 要求一段完整的赋值语句。 */
  assignmentSemicolon?: boolean;
  /** 赋值后的会话快照；`reason`（如 6 = reason_enter）等停止位置字段都在这里。 */
  snapshot?: PlDebugStatus;
}

/**
 * 在 **debuggee 会话**里执行一条语句的结果（`DBMS_DEBUG.EXECUTE`）。
 *
 * 这是唯一能看到调试会话未提交状态（未提交的行、包状态）的通道：调试器连接是另一个
 * 会话，读一致性隔离看不到那些改动。`rows` 是服务器返回的行文本，`error` 是服务器
 * 自己的拒绝理由（例如没有停靠点、ORA-00942）。
 */
export interface PlDebugExecuteResult {
  ok?: boolean;
  rows?: Array<string | null>;
  count?: number;
  message?: string;
  error?: string;
  complete?: boolean;
  truncated?: boolean;
  resultError?: string;
}

/**
 * 在 debuggee 会话的全局上下文执行语句（frame# = -1），不使用选中帧的局部作用域；
 * PL/SQL 块（DECLARE/BEGIN）会把 `:1` 集合的内容作为结果行返回，纯 SQL 语句不返回行。
 */
export async function plDebugExecute(debugId: string, sql: string, maxRows = 0): Promise<PlDebugExecuteResult> {
  return invoke("pl_debug_execute", { debugId, sql, maxRows });
}

/**
 * DBMS_DEBUG.SET_VALUE：修改变量/参数的值。frame/index 分别定位栈帧与同名
 * 变量展开项的下标（复合类型字段），两者省略时后端按 0 处理。
 */
export async function plDebugSetValue(debugId: string, name: string, frame: number, index: number, value: string): Promise<PlDebugSetValueResult> {
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
