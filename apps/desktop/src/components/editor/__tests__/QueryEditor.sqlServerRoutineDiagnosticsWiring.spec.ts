import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * SQL Server 例程批次的语法诊断接线（#9315）写在 `<script setup>` 内部，
 * 无法直接 import，因此沿用仓库既有做法（QueryEditor.cteNavigationWiring.spec.ts）
 * 对源码做结构断言。规则本身由 sqlServerRoutineSyntaxDiagnostics.test.ts 覆盖，
 * 批次/视口裁剪由 sqlSemanticDiagnostics.test.ts 覆盖，这里只锁定接线契约。
 */
const source = readFileSync(new URL("../QueryEditor.vue", import.meta.url), "utf8");

function normalizeCode(text: string): string {
  return text.replace(/\s+/g, "").replace(/,(?=[)\]}])/g, "");
}

const normalizedSource = normalizeCode(source);

function expectSourceToContain(fragment: string): void {
  expect(normalizedSource).toContain(normalizeCode(fragment));
}

describe("QueryEditor 的 SQL Server 例程语法诊断接线", () => {
  it("例程批次被跳过整个语义范围后仍单独取回", () => {
    // sqlSemanticDiagnosticRangesForViewport 对例程批次返回空，所以必须再取一次。
    expectSourceToContain('const sqlServerRoutineRanges = props.databaseType === "sqlserver" ? sqlServerRoutineDefinitionRangesForViewport(sql, visibleRanges) : [];');
    // 例程批次不能因为普通范围为空就提前 return，否则过程体永远不检查。
    expectSourceToContain("if (diagnosticRanges.length === 0 && sqlServerRoutineRanges.length === 0) {");
  });

  it("例程批次只跑 token 规则，不做引用分析", () => {
    expectSourceToContain("nextDiagnostics.push(...offsetSqlSemanticDiagnostics(buildSqlServerRoutineSyntaxDiagnostics(range.sql, props.databaseType), range, sql));");
  });

  it("增量刷新时把例程批次一并纳入替换范围，避免旧诊断残留", () => {
    expectSourceToContain("replaceSemanticDiagnosticsInRanges(nextDiagnostics, [...diagnosticRanges, ...sqlServerRoutineRanges], sql);");
  });
});
