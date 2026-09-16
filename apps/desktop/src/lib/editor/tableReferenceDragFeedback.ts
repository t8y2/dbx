/**
 * 表引用拖拽（侧边栏表/列、查询结果列头）共用的指针模拟拖拽反馈：
 * 跟随鼠标的 chip 浮层 + body copy 光标。落点探测与插入见 queryEditorTableDrop.ts。
 */

export const QUERY_EDITOR_DROP_TARGET_SELECTOR = "[data-query-editor-root]";

/** 拖拽期间加在 body 上，禁用文本选择（样式见 globals.css）。 */
export const TABLE_REFERENCE_DRAGGING_CLASS = "dbx-table-reference-dragging";

const CHIP_OFFSET_X = 14;
const CHIP_OFFSET_Y = 18;
const CHIP_VIEWPORT_MARGIN = 8;

/**
 * elementFromPoint 命中 root 内部才算命中；elementFromPoint 可能被透明覆盖层
 * 拦截（面板层等），此时回退为 root 包围盒的几何包含判定。
 */
export function isPointOverElementRoot(clientX: number, clientY: number, root: Element | null | undefined, doc: Document = document): boolean {
  if (!root) return false;
  const target = doc.elementFromPoint(clientX, clientY);
  if (target instanceof Element && root.contains(target)) return true;
  const rect = root.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

export function isOverSqlEditorTarget(clientX: number, clientY: number, doc: Document = document): boolean {
  for (const root of doc.querySelectorAll(QUERY_EDITOR_DROP_TARGET_SELECTOR)) {
    if (isPointOverElementRoot(clientX, clientY, root, doc)) return true;
  }
  return false;
}

/** 多列摘要由 i18n 插值完成：调用方以 { names: 前两个列名, count: 总数 } 调 t("grid.columnDragChipMany", ...)。 */

export interface TableReferenceDragFeedback {
  update(clientX: number, clientY: number): void;
  end(): void;
}

export function beginTableReferenceDragFeedback(label: string, doc: Document = document): TableReferenceDragFeedback {
  const chip = doc.createElement("div");
  chip.dataset.tableReferenceDragChip = "";
  chip.setAttribute("aria-hidden", "true");
  chip.className = "pointer-events-none fixed z-[9999] max-w-72 truncate rounded-md border border-border bg-popover px-2 py-1 font-mono text-xs leading-4 text-popover-foreground shadow-lg";
  chip.textContent = label;
  chip.style.visibility = "hidden";
  doc.body.appendChild(chip);
  doc.body.classList.add(TABLE_REFERENCE_DRAGGING_CLASS);
  doc.body.style.cursor = "copy";

  const viewport = doc.defaultView ?? window;
  const update = (clientX: number, clientY: number) => {
    if (chip.style.visibility === "hidden") chip.style.visibility = "visible";
    const rect = chip.getBoundingClientRect();
    const x = Math.min(clientX + CHIP_OFFSET_X, viewport.innerWidth - rect.width - CHIP_VIEWPORT_MARGIN);
    const y = Math.min(clientY + CHIP_OFFSET_Y, viewport.innerHeight - rect.height - CHIP_VIEWPORT_MARGIN);
    chip.style.left = `${Math.max(CHIP_VIEWPORT_MARGIN, x)}px`;
    chip.style.top = `${Math.max(CHIP_VIEWPORT_MARGIN, y)}px`;
  };

  return {
    update,
    end() {
      chip.remove();
      doc.body.classList.remove(TABLE_REFERENCE_DRAGGING_CLASS);
      if (doc.body.style.cursor === "copy") doc.body.style.cursor = "";
    },
  };
}
