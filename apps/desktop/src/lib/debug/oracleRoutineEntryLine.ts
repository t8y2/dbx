import type { ObjectSourceKind } from "@/types/database";
import { stripPlSqlComments } from "@/lib/debug/plDebugAnonymousBlock";

/**
 * 子程序入口断点的行号解析。
 *
 * DBMS_DEBUG 的断点只能给「程序 + 行号」。对象的入口有两处可放：
 *   1. **子程序头行**（`PROCEDURE NAME(...) IS` / `FUNCTION NAME RETURN ... IS`）——
 *      DBMS_DEBUG.PROGRAM_INFO 的 `entrypointname` 臂就是把它当成入口点，但真机上
 *      「头行是否可断」仍在用探针验证（结论回来前不要当成既定事实）；
 *   2. **子程序体第一条可执行语句**（`BEGIN` 之后第一条非空非注释行）—— 头行不被
 *      服务器接受时的回退点。
 * 两者都由本模块给出，调用方**先试头行、失败再试回退行**，并把最终失败原样报给用户。
 *
 * 解析是纯文本的、有意保守：宁可返回 null 让调用方报错，也不要猜一个行号把断点设到
 * 错误的行上（断点错位的表现是「程序不按预期停」，比一个明确的失败难查得多）。
 *
 * **真机探针未决项**：头行是否可断（`entrypointname` 臂）正在真机验证；结论回来之前调用方
 * 一律「先试头行、失败再试候选行」。结论回来后唯一需要改的地方就是**入口行号的来源**：
 * 若头行可断，删掉调用方的回退即可（本模块与 `ObjectBrowser.setRoutineEntryBreakpoint`
 * 的尝试顺序），解析规则本身不必改。
 */

/** 一次入口解析的结果；`candidateLine` 为 null 表示该子程序体没有单独的语句行。 */
export interface OracleRoutineEntryLines {
  /** 子程序头行的 1-based 行号。 */
  headLine: number;
  /** 子程序体 `BEGIN` 之后第一条非空非注释行的 1-based 行号；没有则为 null。 */
  candidateLine: number | null;
}

/** 子程序头：允许 `CREATE [OR REPLACE]` / `EDITIONABLE` 前缀，名字可带双引号。 */
const ROUTINE_HEADER = /^\s*(?:CREATE\s+(?:OR\s+REPLACE\s+)?)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(PROCEDURE|FUNCTION)\s+("?[A-Za-z_][A-Za-z0-9_$#]*"?)/i;

/** 去掉标识符两端的双引号；引号内的名字大小写敏感，比较时由调用方决定。 */
function unquoteIdentifier(raw: string): string {
  return raw.startsWith('"') && raw.endsWith('"') && raw.length > 1 ? raw.slice(1, -1) : raw;
}

/**
 * 在对象源码里找到 `routineName` 的子程序头行，以及它之后的第一条可执行候选行。
 *
 * 找不到该子程序时返回 null（调用方据此报错，绝不静默）；找到头行但没有独立的语句行
 * （例如整段写在一行）时返回 `candidateLine: null`。
 *
 * 源码既可以是独立过程/函数的 ALL_SOURCE（`PROCEDURE NAME ...`），也可以是包体
 * （此时行号就是 ALL_SOURCE 行号，与 DBMS_DEBUG 断点行号一致）。
 */
export function resolveRoutineEntryLine(source: string, routineName: string): OracleRoutineEntryLines | null {
  const wanted = unquoteIdentifier(routineName.trim());
  if (!wanted) return null;
  // 逐行剥离注释（保持行数不变），这样得到的行号可以直接用于断点。
  const codeLines = stripPlSqlComments(source).split(/\r?\n/);

  let headerIndex = -1;
  for (let index = 0; index < codeLines.length; index += 1) {
    const match = ROUTINE_HEADER.exec(codeLines[index]);
    if (!match) continue;
    if (unquoteIdentifier(match[2]).toUpperCase() === wanted.toUpperCase()) {
      headerIndex = index;
      break;
    }
  }
  if (headerIndex === -1) return null;

  return { headLine: headerIndex + 1, candidateLine: routineBodyCandidateLine(codeLines, headerIndex) };
}

/**
 * 子程序体 `BEGIN` 之后的第一条非空非注释行。
 *
 * 难点是**哪个** `BEGIN` 是子程序自己的：声明区里可以再声明子程序（`PROCEDURE INNER IS
 * ... BEGIN ... END;`），包体内还有别名的兄弟子程序。所以扫描时维护一个块栈：
 *   - 见到 `PROCEDURE`/`FUNCTION` 头 → 压入一个「还没进体的子程序」帧；
 *   - 见到 `BEGIN` → 栈顶若是「还没进体」的帧，这个 `BEGIN` 就是它的体（对目标帧而言
 *     就是我们要找的那一个）；否则压入一个匿名块帧；
 *   - 见到 `END`（`END IF`/`END LOOP`/`END CASE` 除外）→ 弹栈。
 * 这样嵌套子程序与嵌套匿名块都被跳过，取到的是目标子程序自己的体。
 */
function routineBodyCandidateLine(codeLines: string[], headerIndex: number): number | null {
  type Frame = { kind: "routine" | "subprogram" | "block"; began: boolean };
  const stack: Frame[] = [{ kind: "routine", began: false }];
  let bodyIndex = -1;

  for (let index = headerIndex + 1; index < codeLines.length; index += 1) {
    const code = codeLines[index].trim();
    if (!code) continue;
    const upper = code.toUpperCase();
    if (/^(PROCEDURE|FUNCTION)\b/.test(upper)) {
      stack.push({ kind: "subprogram", began: false });
      continue;
    }
    if (/^BEGIN\b/.test(upper)) {
      const top = stack[stack.length - 1];
      if (top.began) {
        stack.push({ kind: "block", began: true });
        continue;
      }
      top.began = true;
      if (top.kind === "routine") {
        bodyIndex = index;
        break;
      }
      continue;
    }
    if (/^END\b/.test(upper)) {
      // `END IF` / `END LOOP` / `END CASE` 结束的是一条语句，不是块。
      if (/^END\s+(IF|LOOP|CASE)\b/.test(upper)) continue;
      if (stack.length > 1) stack.pop();
    }
  }
  if (bodyIndex === -1) return null;

  for (let index = bodyIndex + 1; index < codeLines.length; index += 1) {
    const code = codeLines[index].trim();
    if (!code) continue;
    // 这一行就是子程序体自己的终结 `END`（不是嵌套块的 `END`：嵌套块的开启行必然排在它
    // 前面，早就被当成候选返回了）——体里没有语句，回退行不存在。
    if (/^END\b/.test(code.toUpperCase()) && !/^END\s+(IF|LOOP|CASE)\b/.test(code.toUpperCase())) return null;
    return index + 1;
  }
  return null;
}

/**
 * 承载一个子程序行号的字典对象：独立过程/函数取它自己，包成员取包体
 * （包成员的运行行号就是包体 ALL_SOURCE 行号，与 ODC 的 `getContentFromPL` 一致）。
 * 与 `PlDebugSourceEditor` 的取源逻辑同源，避免两处各写一份而漂移。
 */
export function routineSourceObject(input: { objectName: string; objectType: string; packageName?: string | null }): { name: string; objectType: ObjectSourceKind } | null {
  if (input.packageName) return { name: input.packageName, objectType: "PACKAGE_BODY" };
  const kind = input.objectType.toUpperCase();
  if (kind !== "PROCEDURE" && kind !== "FUNCTION") return null;
  if (!input.objectName.trim()) return null;
  return { name: input.objectName, objectType: kind };
}

/**
 * DBMS_DEBUG 寻址用的程序名：包成员是 `PKG.SUB`，独立子程序是裸名字。
 * 与 `plDebugStore` 的 `targetProgramName` 同义（那边从会话目标推导，这边从树节点推导）。
 */
export function routineProgramName(input: { objectName: string; packageName?: string | null }): string {
  return input.packageName ? `${input.packageName}.${input.objectName}` : input.objectName;
}
