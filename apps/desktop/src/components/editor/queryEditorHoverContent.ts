import { copyToClipboard } from "@/lib/common/clipboard";
import { normalizeAlignedSqlWhitespace } from "@/lib/editor/hoverTableSql";
import { constrainSqlHoverLayout } from "@/lib/editor/sqlHoverLayout";
import { createHoverSearch, type HoverSearchController } from "@/lib/editor/sqlHoverSearch";
import type { SqlHighlighter } from "@/lib/sql/sqlHighlighter";
import type { Ref } from "vue";
import type { Composer } from "vue-i18n";
import type { useToast } from "@/composables/useToast";

interface QueryEditorHoverContentOptions {
  isDark: Readonly<Ref<boolean>>;
  t: Composer["t"];
  toast: ReturnType<typeof useToast>["toast"];
}

export function createQueryEditorHoverContent(options: QueryEditorHoverContentOptions) {
  const { isDark, t, toast } = options;
  let hoverSqlHighlighter: SqlHighlighter | null = null;

  function createHoverDom(title: string, detail: string, sqlContent?: string, rows: string[] = []): { dom: HTMLElement; mount?: () => void; destroy?: () => void } {
    const dom = document.createElement("div");
    dom.className = "rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md";

    const heading = document.createElement("div");
    heading.className = "font-medium";
    heading.textContent = title;
    dom.appendChild(heading);

    const detailNode = document.createElement("div");
    detailNode.className = "mt-1 text-muted-foreground";
    detailNode.textContent = detail;
    dom.appendChild(detailNode);

    let layoutController: ReturnType<typeof constrainSqlHoverLayout> | null = null;
    let handleCopy: ((event: ClipboardEvent) => void) | null = null;
    let searchController: HoverSearchController | null = null;

    if (sqlContent) {
      heading.className = "flex items-center justify-between gap-3 font-medium";

      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "rounded border border-border/60 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
      copyButton.textContent = t("grid.copyDdl");
      copyButton.title = t("grid.copyDdl");
      copyButton.setAttribute("aria-label", t("grid.copyDdl"));
      copyButton.addEventListener("pointerdown", (event) => {
        // Keep CodeMirror's editor gestures from dismissing the tooltip before
        // the click can reach the copy action.
        event.preventDefault();
        event.stopPropagation();
      });
      copyButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          try {
            await copyToClipboard(normalizeAlignedSqlWhitespace(sqlContent));
            toast(t("contextMenu.ddlCopied"), 2000);
          } catch (error: any) {
            toast(t("grid.copyFailed", { message: error?.message || String(error) }), 5000);
          }
        })();
      });
      heading.appendChild(copyButton);

      const separator = document.createElement("div");
      separator.className = "mt-2 border-t border-border/60";
      dom.appendChild(separator);

      const sqlContainer = document.createElement("div");
      sqlContainer.className = "mt-1.5 text-[11px] leading-5 whitespace-pre font-mono";

      if (hoverSqlHighlighter) {
        sqlContainer.innerHTML = hoverSqlHighlighter(sqlContent, isDark.value ? "dark" : "light");
      } else {
        sqlContainer.className += " text-muted-foreground";
        sqlContainer.textContent = sqlContent;
      }

      // 纯前端搜索：在已生成的 DDL 内容上做大小写不敏感匹配并高亮，不重新请求元数据/DDL。
      // originalHtml 必须在挂到文档前、内容渲染后捕获，作为每次搜索的还原基线。
      searchController = createHoverSearch({
        target: sqlContainer,
        originalHtml: sqlContainer.innerHTML,
        placeholder: t("grid.hoverSearchPlaceholder"),
        noResultLabel: t("grid.hoverSearchNoResult"),
      });
      dom.appendChild(searchController.element);

      dom.appendChild(sqlContainer);
      dom.appendChild(searchController.status);
      // 返回 mount/destroy 给 CodeMirror TooltipView 生命周期钩子，
      // 避免 MutationObserver 监听 body 全子树来兜底清理。
      layoutController = constrainSqlHoverLayout(dom, sqlContainer);

      // The tooltip pads column names/types with literal spaces so they line up
      // visually (see alignColumnRows). Selecting that text and copying it via
      // the native OS/browser copy carries those spaces verbatim, which shows
      // up as long literal space runs when pasted into a plain-text editor.
      // Normalize just the clipboard payload so the on-screen alignment is
      // untouched but paste targets get clean single-spaced SQL.
      handleCopy = (event: ClipboardEvent) => {
        const selection = document.getSelection();
        if (!selection || selection.isCollapsed) return;
        if (!dom.contains(selection.anchorNode) && !dom.contains(selection.focusNode)) return;
        const text = selection.toString();
        if (text !== sqlContent) return;
        const normalized = normalizeAlignedSqlWhitespace(text);
        if (normalized === text) return;
        event.clipboardData?.setData("text/plain", normalized);
        event.preventDefault();
      };
    }

    for (const row of rows) {
      const rowNode = document.createElement("div");
      rowNode.className = "mt-1 font-mono text-muted-foreground";
      rowNode.textContent = row;
      dom.appendChild(rowNode);
    }

    return {
      dom,
      mount:
        layoutController || handleCopy || searchController
          ? () => {
              layoutController?.mount();
              if (handleCopy) document.addEventListener("copy", handleCopy);
            }
          : undefined,
      destroy:
        layoutController || handleCopy || searchController
          ? () => {
              layoutController?.destroy();
              searchController?.destroy();
              if (handleCopy) document.removeEventListener("copy", handleCopy);
            }
          : undefined,
    };
  }

  function initializeHighlighter() {
    void (async () => {
      try {
        const { createShikiSqlHighlighter } = await import("@/lib/sql/sqlHighlighter");
        hoverSqlHighlighter = await createShikiSqlHighlighter({
          appearance: () => (isDark.value ? "dark" : "light"),
        });
      } catch {
        // Highlighter unavailable; hover falls back to plain text
      }
    })();
  }

  return { createHoverDom, initializeHighlighter };
}
