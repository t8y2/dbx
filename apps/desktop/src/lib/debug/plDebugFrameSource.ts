import type { PlDebugFrame } from "@/lib/backend/pl-debug-tauri";
import type { ObjectSourceKind } from "@/types/database";

/**
 * 跨对象 step-in：把调用栈里的一帧对到「哪个对象的源码上」。
 *
 * 这是纯映射，不碰网络：`StackTracePanel` 用 `frameSourceCandidates` 依次取源、用
 * `frameBelongsToTarget` 决定是否提供「查看该帧源码」，`PlDebugSourceEditor` 只用结果
 * 渲染。两个判定都单独可测 —— 它们错一个的表现分别是「点了没反应」和「给错对象设断点」。
 */

/** 调试目标的最小形状（与 `PlDebugSessionTarget` 兼容）。 */
export interface PlDebugFrameTarget {
  /** PROCEDURE | FUNCTION | ANONYMOUS */
  objectType: string;
  objectName: string | null;
  packageName: string | null;
}

/** 一个可能承载该帧行号的字典对象。 */
export interface PlDebugFrameSourceCandidate {
  /** 对象的 owner（schema）。 */
  owner: string;
  /** 对象名：包成员取包名（行号是包体行号），独立子程序取子程序名。 */
  name: string;
  /**
   * PROCEDURE 表示「独立子程序，PROCEDURE/FUNCTION 未知，交给取源回退去试」；
   * PACKAGE_BODY 表示行号在包体里。
   */
  objectType: ObjectSourceKind;
}

/**
 * 一帧可能属于哪些字典对象，按尝试顺序。
 *
 * 名字形状有三种，来自 agent 从 PRINT_BACKTRACE 解析出的标识符（`plDebugIsProgramName`
 * 保证它只含标识符字符与点号）：
 *   - `SUB`：独立子程序，也可能是一个包的初始化段（包名没有点号）。两种都试：
 *     先按独立子程序（PROCEDURE→FUNCTION 的回退在取源函数里），再按包体。
 *   - `PKG.SUB` 或 `OWNER.SUB`：两段名字是**歧义**的 —— Oracle 打印包成员时是
 *     `包名.子程序`，打印独立子程序时可能是 `owner.子程序`。因此先按包成员（取 `PKG` 的
 *     包体）试，再按 owner 限定的独立子程序试。
 *   - `OWNER.PKG.SUB`：三段，唯一的解释是 owner + 包 + 子程序（包成员）。
 *
 * 帧没有命名任何对象（`program` 为空、或含空格如 `ANONYMOUS BLOCK`）时返回空数组；
 * 调用方据此提示「该帧没有可加载源码的对象」，而不是给一个空白视图。
 */
export function frameSourceCandidates(frame: PlDebugFrame | null | undefined, fallbackOwner: string): PlDebugFrameSourceCandidate[] {
  const program = (frame?.program ?? "").trim();
  if (!program || !/^[A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)*$/.test(program)) return [];
  const parts = program.split(".");
  const owner = (frame?.programOwner ?? "").trim() || fallbackOwner;
  if (parts.length === 1) {
    return [
      { owner, name: parts[0], objectType: "PROCEDURE" },
      { owner, name: parts[0], objectType: "PACKAGE_BODY" },
    ];
  }
  if (parts.length === 2) {
    return [
      // 包成员：`program` = 包名.子程序，行号是包体行号。
      { owner, name: parts[0], objectType: "PACKAGE_BODY" },
      // 或：owner 限定的独立子程序。
      { owner: parts[0], name: parts[1], objectType: "PROCEDURE" },
    ];
  }
  return [
    { owner: parts[0], name: parts[1], objectType: "PACKAGE_BODY" },
    { owner: parts[0], name: parts[2], objectType: "PROCEDURE" },
  ];
}

/**
 * 一帧的程序名是不是**当前调试目标**本身。
 *
 * 与 `PlDebugSourceEditor` 判定「当前行高亮是否属于本视图」用的是同一条规则（目标名相等，
 * 或 `PKG.SUB` 以 `.SUB` 结尾）。匿名块目标没有名字：只有**没有**程序名的帧才算它自己，
 * 匿名块里 step-in 进去的子程序帧因此会被认成「另一个对象」并可以查看源码 —— 这正是该
 * 功能存在的意义。
 */
export function frameBelongsToTarget(frame: PlDebugFrame | null | undefined, target: PlDebugFrameTarget | null | undefined): boolean {
  if (!target) return false;
  const program = (frame?.program ?? "").trim().toUpperCase();
  if (target.objectType.toUpperCase() === "ANONYMOUS") return program === "";
  if (program === "") return false;
  const objectName = (target.objectName ?? "").trim().toUpperCase();
  if (objectName === "") return false;
  return program === objectName || program.endsWith(`.${objectName}`);
}
