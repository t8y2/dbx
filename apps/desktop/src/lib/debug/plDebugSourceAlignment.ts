import type { ObjectSource, ObjectSourceKind } from "@/types/database";
import { loadObjectSourceWithRoutineFallback, type GetObjectSourceFn } from "@/lib/table/objectSourceLoad";

/**
 * Oracle 包/包体源码的行号对齐（调试视图专用）。
 *
 * `get_object_source` 对 PACKAGE_BODY 走 `DBMS_METADATA.GET_DDL`，而 DBMS_DEBUG 的
 * 断点行号、停靠行号、栈帧行号都是 **ALL_SOURCE 行号**——那里第 1 行就是
 * `PACKAGE BODY X AS`/`PACKAGE X AS` 这个头行。GET_DDL 在 `CREATE OR REPLACE ...`
 * 行前多输出一个空行（真机实测 2026-10-13：GET_DDL 15 行、ALL_SOURCE 14 行），
 * 于是包成员在调试源码区里**所有行号整体高一行**：当前行高亮落在 CREATE 行上、
 * gutter 断点设到上一行、栈帧源码行同样错位。
 *
 * 去掉开头空行后，编辑器行号与 DBMS_DEBUG 行号一一对应；ALL_SOURCE 形状的源码
 * （独立过程/函数，或返回 ALL_SOURCE 的 profile）首行非空，原样通过；匿名块源码
 * 有自己的行号契约（提交文本即行号），不经过本函数。
 */
export function alignPlDebugSourceLines(source: string): string {
  return source.replace(/^(?:[ \t]*\r?\n)+/, "");
}

/**
 * 调试视图取源：与对象浏览器同一后端（`loadObjectSourceWithRoutineFallback`，含
 * PROCEDURE/FUNCTION 回退），再按 DBMS_DEBUG 行号对齐。两个调试视图（调试源码区、
 * 栈帧源码）都用它，避免各自忘记对齐。
 */
export async function loadPlDebugObjectSource(getObjectSource: GetObjectSourceFn, connectionId: string, database: string, schema: string, name: string, objectType: ObjectSourceKind, signature?: string, relationName?: string): Promise<{ source: ObjectSource; objectType: ObjectSourceKind }> {
  const loaded = await loadObjectSourceWithRoutineFallback(getObjectSource, connectionId, database, schema, name, objectType, signature, relationName);
  return { source: { ...loaded.source, source: alignPlDebugSourceLines(loaded.source.source ?? "") }, objectType: loaded.objectType };
}
