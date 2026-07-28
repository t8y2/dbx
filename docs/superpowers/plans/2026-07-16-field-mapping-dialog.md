# 字段类型映射独立弹窗 + JSON 导入/导出 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在"比较架构"配置步骤的"选项"按钮后增加"字段类型映射"按钮，点击打开独立弹窗编辑映射（内部可滚动、底部操作栏始终可达），并支持映射配置的 JSON 导入/导出。

**架构：** 新建 `FieldMappingDialog.vue` 复用 `SchemaDiffDialog` 已有的 overlay 弹窗模式；通过 `SchemaDiffConfigStep` 透传 `open-field-mapping` 事件到 `SchemaDiffDialog`；弹窗内持有本地副本（`editingMappings`），"完成"时 emit `save` 复用现有 `handleFieldMappingsUpdate` 写回 `activeConfig.options.fieldMappings`。导入/导出采用现有 `TagManagementPanel` 的 Blob 下载 + 隐藏 file input 模式。

**技术栈：** Vue 3 `<script setup>` + TypeScript + Tailwind（shadcn-vue 风格）、`@lucide/vue` 图标、`vue-i18n`（`t()`）、`useToast` composable。无 Rust 变更。

---

## 文件结构

- 新建 `apps/desktop/src/components/diff/FieldMappingDialog.vue`
  - 职责：独立弹窗容器，渲染 `FieldMappingPanel` + 底部导入/导出/完成栏；持有 `editingMappings` 本地副本；实现 `handleExport` / `handleImport` / `onFileSelected`；深拷贝初始化。
- 修改 `apps/desktop/src/components/diff/SchemaDiffConfigStep.vue`
  - 职责：在"选项"按钮后插入"字段类型映射"按钮，新增 `open-field-mapping` emit；保留内嵌 `FieldMappingPanel`。
- 修改 `apps/desktop/src/components/diff/SchemaDiffDialog.vue`
  - 职责：新增 `showFieldMappingDialog` ref，挂载 `<FieldMappingDialog>` 并接线 `open` / `save` / `update:open`，传入 `sourceDbType` / `targetDbType`。
- 修改 `apps/desktop/src/i18n/locales/zh-CN.ts`
  - 职责：在 `schemaDiff.fieldMapping` 对象内新增 `openFieldMapping` / `import` / `export` / `importError` / `done` 键。
- 修改 `apps/desktop/src/i18n/locales/en.ts`
  - 职责：同上英文键。

---

## 任务 1：新建 FieldMappingDialog.vue 容器与导入/导出

**文件：**
- 创建：`apps/desktop/src/components/diff/FieldMappingDialog.vue`

- [ ] **步骤 1：编写组件（script + template + style）**

完整内容如下（注意：`FieldMappingEntry` 来自 `@/types/schemaDiff`；`FieldMappingPanel` 已存在并可复用；`useToast` 提供 `toast(msg, duration?)`）：

```vue
<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Download, Upload, Check, X } from "@lucide/vue";
import FieldMappingPanel from "@/components/diff/FieldMappingPanel.vue";
import type { FieldMappingEntry } from "@/types/schemaDiff";
import { useToast } from "@/composables/useToast";

const props = defineProps<{
  open: boolean;
  mappings: FieldMappingEntry[];
  sourceDbType: string;
  targetDbType: string;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "save", value: FieldMappingEntry[]): void;
}>();

const { t } = useI18n();
const toast = useToast();

const editingMappings = ref<FieldMappingEntry[]>([]);
const fileInputRef = ref<HTMLInputElement | null>(null);

// 打开时深拷贝当前映射为本地副本（单向数据流，取消不写回）
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      editingMappings.value = props.mappings.map((m) => ({ ...m }));
    }
  },
  { immediate: true },
);

function handleUpdateMappings(v: FieldMappingEntry[]) {
  editingMappings.value = v;
}

function handleExport() {
  const blob = new Blob([JSON.stringify(editingMappings.value, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "field-mappings.json";
  a.click();
  URL.revokeObjectURL(url);
}

function handleImportClick() {
  fileInputRef.value?.click();
}

function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result)) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not an array");
      const normalized: FieldMappingEntry[] = parsed.map((item: any) => ({
        sourceType: String(item.sourceType ?? ""),
        targetType: String(item.targetType ?? ""),
        paramStrategy: item.paramStrategy === "strip" || item.paramStrategy === "custom" ? item.paramStrategy : "preserve",
        customParams: item.customParams ? String(item.customParams) : undefined,
      }));
      if (normalized.some((m) => !m.sourceType || !m.targetType)) {
        throw new Error("missing sourceType/targetType");
      }
      editingMappings.value = normalized;
      toast(t("diff.fieldMapping.importSuccess"), 2000);
    } catch {
      toast(t("diff.fieldMapping.importError"), 3000);
    } finally {
      input.value = "";
    }
  };
  reader.onerror = () => toast(t("diff.fieldMapping.importError"), 3000);
  reader.readAsText(file);
}

function handleDone() {
  emit("save", editingMappings.value.map((m) => ({ ...m })));
  emit("update:open", false);
}

function handleClose() {
  emit("update:open", false);
}
</script>

<template>
  <div v-if="open" class="absolute inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center" @click.self="handleClose">
    <div class="bg-card border rounded-lg shadow-lg w-[760px] max-w-[calc(100vw-2rem)] max-h-[80vh] overflow-auto p-4">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-sm font-medium">{{ t("diff.fieldMapping.title") }}</h3>
        <Button variant="ghost" size="sm" @click="handleClose">
          <X class="w-3.5 h-3.5" />
        </Button>
      </div>

      <FieldMappingPanel
        :mappings="editingMappings"
        :source-db-type="sourceDbType"
        :target-db-type="targetDbType"
        @update:mappings="handleUpdateMappings"
      />

      <div class="flex items-center justify-between mt-4 pt-3 border-t">
        <div class="flex items-center gap-2">
          <Button variant="outline" size="sm" @click="handleImportClick">
            <Upload class="w-3.5 h-3.5 mr-1" />
            {{ t("diff.fieldMapping.import") }}
          </Button>
          <Button variant="outline" size="sm" @click="handleExport">
            <Download class="w-3.5 h-3.5 mr-1" />
            {{ t("diff.fieldMapping.export") }}
          </Button>
        </div>
        <Button size="sm" @click="handleDone">
          <Check class="w-3.5 h-3.5 mr-1" />
          {{ t("diff.fieldMapping.done") }}
        </Button>
      </div>

      <input ref="fileInputRef" type="file" accept=".json,application/json" class="hidden" @change="onFileSelected" />
    </div>
  </div>
</template>
```

- [ ] **步骤 2：类型检查确认组件无错误**

运行：`cd apps/desktop && pnpm vue-tsc --noEmit --project tsconfig.json`（或仓库根 `pnpm typecheck`）
预期：该文件无 `FieldMappingDialog` 相关报错（已知 2 个与本次无关的预存错误：`dbAdminSql.ts` / `McpServerStatus.node_path`）。

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/components/diff/FieldMappingDialog.vue
git commit -m "feat(desktop): add FieldMappingDialog with JSON import/export"
```

---

## 任务 2：SchemaDiffConfigStep 增加"字段类型映射"按钮

**文件：**
- 修改：`apps/desktop/src/components/diff/SchemaDiffConfigStep.vue`

- [ ] **步骤 1：在 defineEmits 中新增 open-field-mapping 事件**

定位 `const emit = defineEmits<{ ... }>();` 块，在现有事件（如 `(e: "update:fieldMappings", value: FieldMappingEntry[]): void;`）之后新增一行：

```ts
  (e: "open-field-mapping"): void;
```

- [ ] **步骤 2：在"选项"按钮后插入"字段类型映射"按钮**

定位底部操作栏（约 468-488 行）：

```html
    <!-- Bottom Actions -->
    <div class="flex items-center justify-between pt-2">
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" @click="$emit('saveConfig')">
          <Save class="w-3.5 h-3.5 mr-1" />
          {{ t("diff.saveConfig") }}
        </Button>
        <Button variant="outline" size="sm" @click="$emit('loadConfig')">
          <FolderOpen class="w-3.5 h-3.5 mr-1" />
          {{ t("diff.loadConfig") }}
        </Button>
        <Button variant="outline" size="sm" @click="$emit('showOptions')">
          <Settings class="w-3.5 h-3.5 mr-1" />
          {{ t("diff.options") }}
        </Button>
      </div>
```

在 `{{ t("diff.options") }}` 按钮的 `</Button>` 之后、`</div>` 之前，插入：

```html
        <Button v-if="showFieldMapping" variant="outline" size="sm" @click="$emit('open-field-mapping')">
          <ArrowLeftRight class="w-3.5 h-3.5 mr-1" />
          {{ t("diff.openFieldMapping") }}
        </Button>
```

（注：`showFieldMapping` 已在 `<script>` 中定义为 `computed`，见 `SchemaDiffConfigStep.vue:66`。`ArrowLeftRight` 图标已在文件顶部 import。）

- [ ] **步骤 3：类型检查**

运行：`pnpm typecheck`
预期：无新增该文件报错。

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/components/diff/SchemaDiffConfigStep.vue
git commit -m "feat(desktop): add open-field-mapping button in config step"
```

---

## 任务 3：SchemaDiffDialog 挂载 FieldMappingDialog 并接线

**文件：**
- 修改：`apps/desktop/src/components/diff/SchemaDiffDialog.vue`

- [ ] **步骤 1：导入组件与图标**

在文件顶部 import 区（`SchemaDiffConfigStep` import 附近，约 11 行）新增：

```ts
import FieldMappingDialog from "@/components/diff/FieldMappingDialog.vue";
```

确认 `Download` / `Upload` / `Check` / `X` 不需要在此文件导入（`FieldMappingDialog` 内部已自带）。

- [ ] **步骤 2：新增 ref 并接线到 SchemaDiffConfigStep**

在 `showOptionsPanel` ref 定义附近（约 70 行 `const showOptionsPanel = ref(false);`）新增：

```ts
const showFieldMappingDialog = ref(false);
```

定位 `<SchemaDiffConfigStep ... >`（约 810-831 行），在其 `@update:field-mappings="handleFieldMappingsUpdate"` 之后新增一行：

```html
          @open-field-mapping="showFieldMappingDialog = true"
```

- [ ] **步骤 3：渲染 FieldMappingDialog（放在 showOptionsPanel overlay 之后，约 1055 行 `</DialogContent>` 之前）**

```html
      <!-- Field Mapping Dialog Overlay -->
      <FieldMappingDialog
        :open="showFieldMappingDialog"
        :mappings="activeConfig?.options.fieldMappings ?? []"
        :source-db-type="sourceDbType"
        :target-db-type="targetDbType"
        @update:open="showFieldMappingDialog = $event"
        @save="handleFieldMappingsUpdate"
      />
```

（注：`sourceDbType` / `targetDbType` 已在 `SchemaDiffDialog` 的 `<script>` 中计算，`handleFieldMappingsUpdate(mappings: FieldMappingEntry[])` 签名见 298 行，直接复用。）

- [ ] **步骤 4：类型检查**

运行：`pnpm typecheck`
预期：无新增报错。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/components/diff/SchemaDiffDialog.vue
git commit -m "feat(desktop): wire FieldMappingDialog into SchemaDiffDialog"
```

---

## 任务 4：i18n 新增键（zh-CN + en）

**文件：**
- 修改：`apps/desktop/src/i18n/locales/zh-CN.ts`
- 修改：`apps/desktop/src/i18n/locales/en.ts`

- [ ] **步骤 1：zh-CN 新增键**

定位 `schemaDiff.fieldMapping` 对象（约 2444 行 `fieldMapping: {`）。在 `selectPreset: "选择预设...",` 行之后新增：

```ts
      openFieldMapping: "字段类型映射",
      import: "导入",
      export: "导出",
      importSuccess: "导入成功",
      importError: "导入失败：文件不是合法的字段类型映射 JSON",
      done: "完成",
```

- [ ] **步骤 2：en 新增键**

定位 `schemaDiff.fieldMapping` 对象（约 2457 行 `fieldMapping: {`）。在 `selectPreset: "Select preset...",` 行之后新增：

```ts
      openFieldMapping: "Field Type Mapping",
      import: "Import",
      export: "Export",
      importSuccess: "Imported successfully",
      importError: "Import failed: file is not a valid field type mapping JSON",
      done: "Done",
```

- [ ] **步骤 3：类型检查（i18n 为运行时键，typecheck 不校验缺失键，但确认 JSON 结构无语法错误）**

运行：`pnpm typecheck`
预期：无新增报错。

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/i18n/locales/zh-CN.ts apps/desktop/src/i18n/locales/en.ts
git commit -m "feat(desktop): add i18n keys for field mapping dialog"
```

---

## 任务 5：FieldMappingPanel 内嵌滚动兜底

**文件：**
- 修改：`apps/desktop/src/components/diff/FieldMappingPanel.vue`

- [ ] **步骤 1：给映射列表容器加最大高度与滚动**

定位 `<div v-else class="p-3">`（约 100 行，内含映射列表的 `v-else` 分支）。将其改为带 `max-h` + `overflow-auto`，使内嵌面板（非弹窗场景）也能滚动：

```html
    <div v-else class="p-3 max-h-[42vh] overflow-auto">
```

（弹窗场景下外层已有 `max-h-[80vh] overflow-auto`，内层再加一层可滚避免双重长列表；内嵌场景下这层是关键兜底。）

- [ ] **步骤 2：类型检查**

运行：`pnpm typecheck`
预期：无新增报错。

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/components/diff/FieldMappingPanel.vue
git commit -m "feat(desktop): make FieldMappingPanel list scrollable as fallback"
```

---

## 自检（计划作者视角）

**规格覆盖度：**
- 独立弹窗（任务 1 + 3）✓
- "选项"后按钮（任务 2）✓
- 单向数据流 / 取消不写回（任务 1 watch + handleClose）✓
- JSON 导出（任务 1 handleExport，参考 TagManagementPanel）✓
- JSON 导入 + 校验（任务 1 onFileSelected）✓
- 弹窗内滚动 + 内嵌兜底（任务 1 max-h-[80vh] + 任务 5）✓
- 配置步骤底部操作栏始终可见（弹窗隔离映射，任务 3）✓
- i18n（任务 4）✓

**占位符扫描：** 无 TODO / 待定 / "补充细节"。所有步骤含完整代码。

**类型一致性：** `FieldMappingEntry` 来自 `@/types/schemaDiff`；`handleFieldMappingsUpdate(mappings: FieldMappingEntry[])` 在任务 3 复用任务 1 emit 的 `save(FieldMappingEntry[])`；`sourceDbType` / `targetDbType` 在 `SchemaDiffDialog` 已存在；i18n 键在任务 4 定义、任务 1 使用，名称一致（`openFieldMapping` / `import` / `export` / `importSuccess` / `importError` / `done`）。

---

## 验收（手动，pnpm dev）

1. 打开"比较架构"弹窗，源/目标选不同类型 → 出现"字段类型映射"按钮。
2. 点按钮 → 独立弹窗打开，渲染映射面板。
3. 弹窗内添加大量映射 → 弹窗内部可滚动，底部"导入/导出/完成"始终可点。
4. 点"导出" → 下载 `field-mappings.json`，内容为 `FieldMappingEntry[]`。
5. 清空映射后点"导入"选该 json → 映射恢复；非法文件 → 报错 toast 且不替换。
6. 点"完成" → 写回配置步骤；关闭弹窗后底部操作栏（保存/加载/选项/开始比较）始终可见可点。
7. 点遮罩 / ✕ → 未"完成"的修改不写回。
