import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * QueryEditor.vue 的 CTE 接线（hover 溯源、Ctrl+点击跳转、语义模型缓存）都写在
 * `<script setup>` 内部，无法直接 import，因此沿用仓库既有做法
 * （queryEditorExtendSelection.spec.ts 对 queryEditorSource 的结构断言）。
 *
 * 这里锁定回归成本最高的两类契约：分支先后顺序、关键调用参数。算法本身由
 * cteNavigation.spec.ts / model.spec.ts / sqlNavigation.spec.ts 覆盖。
 */
const source = readFileSync(new URL("../QueryEditor.vue", import.meta.url), "utf8");

/** 截取 `<script setup>` 顶层函数体，避免跨函数误匹配。 */
function functionBody(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `QueryEditor.vue 缺少函数 ${name}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}", start);
  expect(end, `${name} 函数体未闭合`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function positionOf(fragment: string): number {
  const index = source.indexOf(fragment);
  expect(index, `QueryEditor.vue 缺少片段: ${fragment}`).toBeGreaterThanOrEqual(0);
  return index;
}

/**
 * 结构片段的归一化：去掉全部空白与"闭合前的尾逗号"。
 * oxfmt（lint-staged 钩子会执行）会在单行与多行之间重排数组/对象字面量，
 * 归一化后断言只对代码结构敏感，不会因为纯格式变动而误报。
 */
function normalizeCode(text: string): string {
  return text.replace(/\s+/g, "").replace(/,(?=[)\]}])/g, "");
}

const normalizedSource = normalizeCode(source);

/** 期望片段照常写成可读形式，比较时两侧一起归一化。 */
function expectSourceToContain(fragment: string): void {
  expect(normalizedSource).toContain(normalizeCode(fragment));
}

describe("QueryEditor hover 的语义模型缓存接线", () => {
  it("hover 复用 getEditorSemanticModel，而不是每次重新解析", () => {
    expect(source).toContain("semanticModel = getEditorSemanticModel(sql, pos, currentView.state);");
    // 换回逐次解析会让 hover 在每次移动时重复建模型（原实现即为此形态）。
    expect(source).not.toContain("buildSqlSemanticModel(sql, pos, sqlCompletionDialectOptions())");
  });

  it("缓存键覆盖文档/编辑器状态/位置/数据库类型/方言，且只在拿到 doc 时写缓存", () => {
    const body = functionBody("getEditorSemanticModel");

    expect(body).toContain("if (!SEMANTIC_SQL_COMPLETION_ENABLED) return null;");
    for (const key of ["editorSemanticModelCache?.doc === doc", "editorSemanticModelCache.editorState === editorState", "editorSemanticModelCache.position === position", "editorSemanticModelCache.databaseType === props.databaseType", "editorSemanticModelCache.dialect === dialect"]) {
      expect(body, `缓存键缺少 ${key}`).toContain(key);
    }
    // 没有 doc（手动构造的 state）时不能留下无法复用的缓存项。
    expect(body).toMatch(/if \(doc\) \{\s*editorSemanticModelCache = \{/);
  });
});

describe("QueryEditor hover 的 CTE 溯源接线", () => {
  it("CTE 分支排在通用表/列回退之前", () => {
    const cteBranch = positionOf("const cteColumn = await resolveCteColumnHoverColumn(semanticModel, name, qualifier);");
    const genericFallback = positionOf("const hoverTarget = completionMetadataTarget({");

    expect(cteBranch).toBeLessThan(genericFallback);
  });

  it("命中物理列后按 类型/来源/注释 生成悬浮内容，未命中则回退", () => {
    expectSourceToContain('createHoverDom(cteColumn.name, cteColumn.dataType || "column", undefined, [cteColumn.schema ? `${cteColumn.schema}.${cteColumn.table}` : cteColumn.table, ...(cteColumn.comment?.trim() ? [cteColumn.comment.trim()] : [])])');
    // 只有拿到列才提前返回，否则继续走原有表/列逻辑。
    expect(source).toContain("if (cteColumn) {");
  });
});

describe("resolveCteColumnHoverColumn 的溯源接线", () => {
  const body = functionBody("resolveCteColumnHoverColumn");

  it("未命中或不可溯源时返回 null，交由上层回退", () => {
    expect(body).toContain("const hit = findCteColumnResolution(semanticModel, columnName, qualifier);");
    expect(body).toContain("if (!hit) return null;");
    expect(body).toContain("const origins: CteColumnOrigin[] = resolveCteColumnOrigins(semanticModel, hit, columnName);");
    expect(body).toContain("if (origins.length === 0) return null;");
    // 元数据抓取异常同样只降级为回退，不能把 hover 打崩。
    expect(body).toMatch(/catch \{\s*return null;\s*\}/);
  });

  it("复用共享列缓存并做大小写不敏感匹配，取第一个命中", () => {
    expect(body).toContain("const reference = referencedTableLikeFromSemanticSource(origin.source);");
    expect(body).toContain("await ensureColumnsForTable(reference, reference);");
    expect(body).toContain("const columns = cachedColumnsByTable.get(completionCacheKey(reference));");
    expect(body).toContain("candidate.name.toLowerCase() === origin.column.toLowerCase()");
    expect(body).toContain("return matched.find((column) => column != null) ?? null;");
  });

  it("多星号产生的多个来源并发取元数据，顺序即优先级，第一个命中者胜出", () => {
    const body = functionBody("resolveCteColumnHoverColumn");

    // 顺序即优先级：谁先取到真实列元数据就用谁（歧义 SQL 的裁决点就在这里）。
    expect(body).toContain("origins.map(async (origin) => {");
    expect(body).toContain("?? null;");
    expect(body.indexOf("origins.map(async (origin) => {")).toBeLessThan(body.indexOf("return matched.find((column) => column != null) ?? null;"));

    // 第二个来源直接复用第一个来源已建好的缓存，不会重复发起元数据查询。
    expect(body).toContain("cachedColumnsByTable.get(completionCacheKey(reference))");
  });

  it("把语义来源映射成列缓存所需的表标识（含引号与 schema）", () => {
    const mapBody = functionBody("referencedTableLikeFromSemanticSource");

    expect(mapBody).toContain("const identifierParts = source.qualifiedName?.parts ?? [];");
    expect(mapBody).toContain("name: source.name,");
    expect(mapBody).toContain("nameQuoted: !!identifierParts[identifierParts.length - 1]?.quote,");
    expect(mapBody).toContain("database: source.metadataTarget?.database,");
    expect(mapBody).toContain("schema: source.qualifierParts[source.qualifierParts.length - 1],");
    expect(mapBody).toContain("schemaQuoted: source.qualifierParts.length > 0 ? !!identifierParts[identifierParts.length - 2]?.quote : undefined,");
  });
});

describe("QueryEditor Ctrl+点击的 CTE 跳转接线", () => {
  it("CTE 分支排在本地表缓存之前", () => {
    const cteBranch = positionOf("const cteModel = getEditorSemanticModel(doc, pos, currentView.state);");
    const localTableCache = positionOf("// 1. Local table lookup with the resolved scope");

    expect(source).toContain("// 0. CTE (WITH ... AS) in-editor navigation");
    expect(cteBranch).toBeLessThan(localTableCache);
  });

  it("CTE 引用名命中时跳到定义名 token，并高亮整个 CTE 定义", () => {
    expect(source).toContain("const referenceHit = findCteReferenceAt(cteModel, pos);");
    expect(source).toContain("if (referenceHit?.definition.nameSpan) {");
    expectSourceToContain("{ from: referenceHit.definition.nameSpan.start, to: referenceHit.definition.nameSpan.end }");
    expectSourceToContain("{ from: referenceHit.definition.sourceSpan.start, to: referenceHit.definition.sourceSpan.end }");
  });

  it("CTE 列命中时跳到 output 的 jumpSpan 或 body 星号，限定符取倒数列段", () => {
    expect(source).toContain("const clickQualifier = identity.parts.length >= 2 ? identity.parts[identity.parts.length - 2]?.value : undefined;");
    expect(source).toContain("const columnHit = findCteColumnResolution(cteModel, identity.name, clickQualifier);");
    expect(source).toContain("const columnTargetSpan = columnHit?.output?.jumpSpan ?? columnHit?.stars?.[0]?.starSpan;");
    expect(source).toContain("if (columnHit && columnTargetSpan) {");
    expectSourceToContain("{ from: columnTargetSpan.start, to: columnTargetSpan.end }");
  });

  it("解析失败只告警，不阻断后续表/列跳转", () => {
    expect(source).toContain('console.warn("[DBX] CTE ctrl+click resolution failed:", error);');

    const cteBlock = source.slice(positionOf("const cteModel = getEditorSemanticModel(doc, pos, currentView.state);"), positionOf("// 1. Local table lookup with the resolved scope"));
    // 两个成功分支各自提前 return；catch 分支只能 warn，否则会吞掉原有的表/列跳转。
    expect(cteBlock.match(/return;/g) ?? []).toHaveLength(2);
    expect(cteBlock).not.toMatch(/catch \(error\) \{[\s\S]*?return/);
  });
});

describe("jumpToCteRange 的跳转范围处理", () => {
  const body = functionBody("jumpToCteRange");

  it("缺少视图或 CodeMirror 模块时直接返回", () => {
    expect(body).toContain("if (!currentView || !editorViewModule || !setResultSourceRangeEffect) return;");
  });

  it("把目标与高亮范围都收敛到文档长度内", () => {
    expect(body).toContain("const docLength = currentView.state.doc.length;");
    expect(body).toContain("const targetFrom = Math.max(0, Math.min(target.from, docLength));");
    expect(body).toContain("const targetTo = Math.max(targetFrom, Math.min(target.to, docLength));");
    expect(body).toContain("const highlightFrom = Math.max(0, Math.min(highlight.from, docLength));");
    expect(body).toContain("const highlightTo = Math.max(highlightFrom, Math.min(highlight.to, docLength));");
  });

  it("空目标不动光标，命中时选中目标 token 并高亮整个定义块", () => {
    expect(body).toContain("if (targetFrom >= targetTo) return;");
    expect(normalizeCode(body)).toContain(normalizeCode("selection: { anchor: targetFrom, head: targetTo }"));
    expectSourceToContain("setResultSourceRangeEffect.of({ from: highlightFrom, to: highlightTo })");
    expectSourceToContain('editorViewModule.EditorView.scrollIntoView(targetFrom, { y: "center" })');
    expect(body).toContain("currentView.focus();");
  });
});
