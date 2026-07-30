# 字段类型映射：独立弹窗 + 导入/导出

日期：2026-07-16
状态：已批准（待实现）

## 背景 / 问题

在"比较架构"配置步骤（`SchemaDiffConfigStep.vue`）中，字段类型映射面板
（`FieldMappingPanel`）直接内嵌在配置步骤里，没有内部滚动。当用户添加大量
映射条目时，面板会把底部的操作栏（保存配置 / 加载配置 / 选项 / 开始比较）
顶出视口，导致这些按钮无法点击、看不到。

用户要求：在"选项"按钮后面增加一个"字段类型映射"按钮，点击打开一个独立的
页面/弹窗来配置映射；并且该弹窗需要支持以 JSON 格式导入、导出映射配置，
参考现有导出功能。

## 目标

1. 字段类型映射添加再多，配置步骤底部的操作栏始终可见、可点击。
2. 提供独立弹窗编辑映射，体验与现有"选项"弹窗一致。
3. 弹窗内支持映射配置的 JSON 导入与导出。

## 非目标（YAGNI）

- 不新增映射列表内的搜索/过滤框（后续可加）。
- 不改动 Rust 侧逻辑（`FieldMapping` / `generate_schema_sync_sql` 已在上一个
  会话修复）。
- 不改动配置整体的保存/加载/历史逻辑。

## 方案

采用方案 A：在"选项"按钮后增加一个"字段类型映射"按钮，点击打开一个叠加
Dialog（overlay），与现有"选项"弹窗（`SchemaDiffDialog` 的 `showOptionsPanel`）
同一风格。

### 1. 组件结构

- **新建 `apps/desktop/src/components/diff/FieldMappingDialog.vue`**
  - 复用 `SchemaDiffDialog` 的 overlay 模式：`absolute inset-0 bg-background/80
    backdrop-blur-sm z-50 flex items-center justify-center`，内层
    `bg-card border rounded-lg shadow-lg w-[760px] max-w-[calc(100vw-2rem)]
    max-h-[80vh] overflow-auto p-4`。
  - 内部渲染 `FieldMappingPanel`（`source-db-type` / `target-db-type` /
    `:mappings` / `@update:mappings`）。
  - 底部操作栏：导入 / 导出 / 完成（✕ 关闭在右上角）。
  - Props：`open: boolean`、`mappings: FieldMappingEntry[]`、
    `sourceDbType: string`、`targetDbType: string`。
  - Emits：`update:open(boolean)`、`save(FieldMappingEntry[])`。
  - 打开时把 `mappings` 深拷贝为本地 `editingMappings`（单向数据流，取消不写回）。

- **改动 `apps/desktop/src/components/diff/SchemaDiffConfigStep.vue`**
  - 在"选项"按钮（`@show-options`）之后、同一 `<div class="flex items-center gap-2">`
    内，插入"字段类型映射"按钮：`v-if="showFieldMapping"`，
    `@click="$emit('open-field-mapping')"`，文案 `t('diff.openFieldMapping')`，
    图标 `ListChecks` 或 `ArrowLeftRight`。
  - 保留现有内嵌 `<FieldMappingPanel>`（行 429）作为快捷入口，行为不变。
  - `defineEmits` 新增 `(e: "open-field-mapping"): void;`。

- **改动 `apps/desktop/src/components/diff/SchemaDiffDialog.vue`**
  - 新增 `const showFieldMappingDialog = ref(false);`
  - `<SchemaDiffConfigStep>` 增加 `@open-field-mapping="showFieldMappingDialog = true"`。
  - 在 `showOptionsPanel` overlay 之后，新增 `<FieldMappingDialog>`：
    - `:open="showFieldMappingDialog"`
    - `:mappings="activeConfig?.options.fieldMappings ?? []"`
    - `:source-db-type="sourceDbType"`、`:target-db-type="targetDbType"`
      （沿用 `SchemaDiffConfigStep` 中既有的 source/target db type 取值方式）
    - `@update:open="showFieldMappingDialog = $event"`
    - `@save="handleFieldMappingsUpdate"`（复用现有写回函数，签名一致：
      `(v: FieldMappingEntry[]) => void`）

### 2. 数据流（单向，与 Options 一致）

打开弹窗 → 用当前 `fieldMappings` 深拷贝为本地 `editingMappings`
（`JSON.parse(JSON.stringify(...))` 或 `map` 拷贝）→ 弹窗内增删改只动本地副本
→ 点"完成" → `emit('save', editingMappings)` → `handleFieldMappingsUpdate`
写回 `activeConfig.options.fieldMappings` → 关闭弹窗。
点遮罩 / ✕ 仅关闭，不写回（取消）。

### 3. 导入 / 导出（JSON）

参考现有 `TagManagementPanel.handleExport`（Blob 下载）与
`useSchemaDiffConfig`（JSON 解析校验）。

- **导出**（`FieldMappingDialog` 内 `handleExport`）：
  ```ts
  const blob = new Blob([JSON.stringify(editingMappings, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "field-mappings.json";
  a.click();
  URL.revokeObjectURL(url);
  ```

- **导入**（`FieldMappingDialog` 内 `handleImport` + 隐藏 file input）：
  - `<input ref="fileInputRef" type="file" accept=".json,application/json" class="hidden" @change="onFileSelected" />`
  - 读取文本 → `JSON.parse` → 校验为数组且每项含 `sourceType` / `targetType` /
    `paramStrategy`（缺 `paramStrategy` 默认 `"preserve"`，缺 `customParams`
    默认 `undefined`）→ 替换本地 `editingMappings`。
  - 解析失败或结构不合法：`toast(t('diff.fieldMapping.importError'))` 并报错，
    不替换。

- **JSON 结构**：即 `FieldMappingEntry[]`：
  ```json
  [
    { "sourceType": "VARCHAR", "targetType": "character", "paramStrategy": "preserve" },
    { "sourceType": "DECIMAL", "targetType": "numeric", "paramStrategy": "custom", "customParams": "(10,2)" }
  ]
  ```
  与运行时 / Rust 侧 `FieldMapping` 对齐，可被 `generate_schema_sync_sql`
  直接消费。

### 4. 滚动与可达性（根本修复）

- 弹窗内部 `max-h-[80vh] overflow-auto`：映射再多也在弹窗内滚动，绝不撑出视口。
- 同时给 `FieldMappingPanel` 的映射列表容器（`v-else` 分支根 `div`）加
  `max-h-[40vh] overflow-auto` 作为内嵌兜底，保证即便内嵌面板也滚动。

### 5. i18n

复用现有 `diff.fieldMapping.*` 键。新增（zh-CN / en，其余语言按现有
`exportConfig`/`importConfig` 模式补，本次至少保证 zh-CN + en）：

- `diff.openFieldMapping`：打开字段类型映射弹窗的按钮文案
  （zh-CN: "字段类型映射"；en: "Field Type Mapping"）
- `diff.fieldMapping.import`：导入（zh-CN: "导入"；en: "Import"）
- `diff.fieldMapping.export`：导出（zh-CN: "导出"；en: "Export"）
- `diff.fieldMapping.importError`：导入失败提示
  （zh-CN: "导入失败：文件不是合法的字段类型映射 JSON"；
   en: "Import failed: file is not a valid field type mapping JSON"）
- `diff.fieldMapping.done`：完成按钮（zh-CN: "完成"；en: "Done"）

位置：zh-CN.ts 的 `schemaDiff.fieldMapping` 对象内（约 2444 行）；
en.ts 的 `schemaDiff.fieldMapping` 对象内（约 2457 行）。

### 6. 测试 / 验收

纯前端改动，无 Rust 逻辑变更。手动验收（`pnpm dev`）：

1. 打开"比较架构"弹窗，源/目标选择不同类型（触发 `showFieldMapping`）。
2. 点"选项"后的"字段类型映射"按钮 → 弹出独立弹窗。
3. 在弹窗内添加大量映射，确认弹窗内部可滚动、底部"导入/导出/完成"始终可点。
4. 点"导出" → 下载 `field-mappings.json`，内容正确。
5. 清空映射后点"导入"，选择刚导出的 json → 映射恢复。
6. 点"完成" → 映射写回配置步骤；关闭弹窗后配置步骤底部操作栏（保存/加载/
   选项/开始比较）始终可见可点。
7. 点遮罩 / ✕ 关闭弹窗 → 本地未"完成"的修改不写回。

类型检查：`pnpm typecheck`（仅关注本次改动文件无新增错误；已知 2 个与本次无关的
预存错误：`dbAdminSql.ts` / `McpServerStatus.node_path`）。

## 受影响文件

- 新建 `apps/desktop/src/components/diff/FieldMappingDialog.vue`
- 改 `apps/desktop/src/components/diff/SchemaDiffConfigStep.vue`
- 改 `apps/desktop/src/components/diff/SchemaDiffDialog.vue`
- 改 `apps/desktop/src/i18n/locales/zh-CN.ts`
- 改 `apps/desktop/src/i18n/locales/en.ts`
- （可选，非必须）其他语言 locale 的 `schemaDiff.fieldMapping` 补键

## 风险 / 注意

- `FieldMappingPanel` 现有 `space-y-3` 列表容器加上 `max-h` + `overflow-auto`
  后，嵌套在弹窗的 `overflow-auto` 里可能产生双重滚动条；需实测，优先让弹窗
  外层滚动，内层列表仅在高度受限时滚动。
- 导入校验要宽松：允许缺省 `customParams` / `paramStrategy`，避免严格校验把
  合法旧配置拒掉。
