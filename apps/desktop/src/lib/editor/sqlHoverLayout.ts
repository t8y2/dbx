const SQL_HOVER_VIEWPORT_GUTTER = "24px";

/** Keep table-DDL hovers readable without allowing one long line to size the tooltip. */
export function constrainSqlHoverLayout(root: HTMLElement, sqlContent: HTMLElement) {
  root.dataset.sqlStructureHover = "true";
  root.style.boxSizing = "border-box";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.maxHeight = "65vh";
  root.style.maxWidth = `calc(100vw - ${SQL_HOVER_VIEWPORT_GUTTER})`;
  root.style.overflow = "hidden";
  root.style.width = "760px";

  sqlContent.dataset.sqlStructureHoverContent = "true";
  sqlContent.style.flex = "0 1 auto";
  sqlContent.style.maxHeight = "480px";
  sqlContent.style.maxWidth = "100%";
  sqlContent.style.minHeight = "0";
  sqlContent.style.overflow = "auto";
  sqlContent.style.overscrollBehavior = "contain";
  sqlContent.style.scrollbarWidth = "thin";
}
