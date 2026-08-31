import type { AppThemeAppearance } from "@/lib/app/appTheme";
import { snapshotElementToPng, copyPngDataUrlToClipboard, savePngDataUrlToFile } from "@/lib/codeSnapshot/codeSnapshot";

export type GridSnapshotCellValue = string | number | boolean | null;

export interface GridSnapshotSource {
  columns: string[];
  columnTypes?: Array<string | undefined>;
  columnDetails?: Array<string | undefined>;
  rows: GridSnapshotCellValue[][];
  title?: string;
}

export interface GridSnapshotStyleOptions {
  appearance: AppThemeAppearance;
  showTrafficLights?: boolean;
  showFieldNames?: boolean;
  showColumnTypes?: boolean;
  showColumnDetails?: boolean;
  showRowNumbers?: boolean;
  wrapCells?: boolean;
  transpose?: boolean;
  fieldNameLabel?: string;
  compact?: boolean;
}

export interface GridSnapshotMetadataControlState {
  columnTypesDisabled: boolean;
  columnDetailsDisabled: boolean;
}

export function gridSnapshotMetadataControlState(options: { showFieldNames: boolean; hasColumnTypes: boolean; hasColumnDetails: boolean }): GridSnapshotMetadataControlState {
  return {
    columnTypesDisabled: !options.showFieldNames || !options.hasColumnTypes,
    columnDetailsDisabled: !options.showFieldNames || !options.hasColumnDetails,
  };
}

const GRID_SNAPSHOT_BACKGROUND: Record<AppThemeAppearance, string> = {
  light: "#ffffff",
  dark: "#0d1117",
};

const GRID_SNAPSHOT_BAR_BACKGROUND: Record<AppThemeAppearance, string> = {
  light: "#f6f8fa",
  dark: "#161b22",
};

const GRID_SNAPSHOT_TEXT: Record<AppThemeAppearance, string> = {
  light: "#24292f",
  dark: "#e6edf3",
};

const GRID_SNAPSHOT_MUTED: Record<AppThemeAppearance, string> = {
  light: "#57606a",
  dark: "#8b949e",
};

const GRID_SNAPSHOT_BORDER: Record<AppThemeAppearance, string> = {
  light: "#d0d7de",
  dark: "#30363d",
};

const GRID_SNAPSHOT_HEADER: Record<AppThemeAppearance, string> = {
  light: "rgb(239, 239, 239)",
  dark: "rgb(32, 32, 34)",
};

const GRID_SNAPSHOT_STRIPED_ROW: Record<AppThemeAppearance, string> = {
  light: "rgb(240, 240, 240)",
  dark: "rgb(40, 40, 43)",
};

const GRID_SNAPSHOT_ROW_NUMBER: Record<AppThemeAppearance, string> = {
  light: "rgb(255, 255, 255)",
  dark: "rgb(35, 37, 42)",
};

const TRAFFIC_LIGHT_COLORS = ["#ff5f57", "#febc2e", "#28c840"] as const;

export const GRID_SNAPSHOT_CSS = `
.dbx-grid-snapshot,
.dbx-grid-snapshot * { box-sizing: border-box; }
.dbx-grid-snapshot {
  display: inline-block;
  width: max-content;
  min-width: 100%;
  border: 1px solid var(--dbx-grid-snapshot-border);
  border-radius: 8px;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  text-align: left;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .35);
}
.dbx-grid-snapshot__bar { display: flex; width: 100%; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--dbx-grid-snapshot-border); }
.dbx-grid-snapshot__dot { width: 12px; height: 12px; border-radius: 50%; flex: none; }
.dbx-grid-snapshot__title { margin-left: 4px; font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbx-grid-snapshot__table { border-collapse: separate; border-spacing: 0; table-layout: auto; width: 100%; }
.dbx-grid-snapshot__cell { border-right: 1px solid var(--dbx-grid-snapshot-border); border-bottom: 1px solid var(--dbx-grid-snapshot-border); padding: 7px 10px; white-space: nowrap; vertical-align: top; }
.dbx-grid-snapshot__cell--wrapped { max-width: 420px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dbx-grid-snapshot__cell:last-child { border-right: 0; }
.dbx-grid-snapshot__table tbody tr:last-child .dbx-grid-snapshot__cell { border-bottom: 0; }
.dbx-grid-snapshot__cell--header { font-weight: 600; white-space: nowrap; }
.dbx-grid-snapshot__column { display: flex; min-width: 0; flex-direction: column; }
.dbx-grid-snapshot__column-name { line-height: 16px; }
.dbx-grid-snapshot__column-meta { min-height: 12px; font-size: 10px; font-weight: 400; line-height: 12px; }
.dbx-grid-snapshot__cell--row-number { width: 1%; min-width: 42px; text-align: right; font-variant-numeric: tabular-nums; user-select: none; }
.dbx-grid-snapshot__cell--null { font-style: italic; }
`;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function formatGridSnapshotCell(value: GridSnapshotCellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function renderSnapshotBar(title: string | undefined, appearance: AppThemeAppearance, showTrafficLights: boolean): string {
  const dots = showTrafficLights ? TRAFFIC_LIGHT_COLORS.map((color) => `<span class="dbx-grid-snapshot__dot" style="background:${color}"></span>`).join("") : "";
  const titleHtml = title ? `<span class="dbx-grid-snapshot__title" style="color:${GRID_SNAPSHOT_MUTED[appearance]}">${escapeHtml(title)}</span>` : "";
  return `<div class="dbx-grid-snapshot__bar" style="background:${GRID_SNAPSHOT_BAR_BACKGROUND[appearance]};color:${GRID_SNAPSHOT_MUTED[appearance]}">${dots}${titleHtml}</div>`;
}

/** Render a self-contained snapshot table for the selected grid cells. */
export function renderGridSnapshotHtml(source: GridSnapshotSource, options: GridSnapshotStyleOptions): string {
  const appearance = options.appearance;
  const showFieldNames = options.showFieldNames !== false;
  const transpose = options.transpose === true;
  const showColumnTypes = options.showColumnTypes === true && showFieldNames;
  const showColumnDetails = options.showColumnDetails === true && showFieldNames;
  const showRowNumbers = options.showRowNumbers !== false;
  const wrapCells = options.wrapCells === true;
  const compact = options.compact === true;
  const cellPadding = compact ? "3px 8px" : "4px 12px";
  const headerPadding = compact ? "4px 8px" : "6px 8px";
  const fontSize = compact ? "12px" : "13px";
  const rowNumberHeader = showRowNumbers ? `<th class="dbx-grid-snapshot__cell dbx-grid-snapshot__cell--header dbx-grid-snapshot__cell--row-number" style="background:${GRID_SNAPSHOT_HEADER[appearance]};color:${GRID_SNAPSHOT_MUTED[appearance]};padding:${headerPadding}">#</th>` : "";
  const renderFieldCell = (column: string, columnIndex: number, tag: "th" | "td") => {
    const type = showColumnTypes ? source.columnTypes?.[columnIndex] : undefined;
    const detail = showColumnDetails ? source.columnDetails?.[columnIndex] : undefined;
    return `<${tag} class="dbx-grid-snapshot__cell dbx-grid-snapshot__cell--header" style="background:${GRID_SNAPSHOT_HEADER[appearance]};color:${GRID_SNAPSHOT_TEXT[appearance]};padding:${headerPadding}"><span class="dbx-grid-snapshot__column"><span class="dbx-grid-snapshot__column-name">${escapeHtml(column)}</span>${type ? `<span class="dbx-grid-snapshot__column-meta" style="color:${GRID_SNAPSHOT_MUTED[appearance]}">${escapeHtml(type)}</span>` : ""}${detail ? `<span class="dbx-grid-snapshot__column-meta" style="color:${GRID_SNAPSHOT_MUTED[appearance]}">${escapeHtml(detail)}</span>` : ""}</span></${tag}>`;
  };
  const header = transpose
    ? `<thead><tr>${rowNumberHeader}${showFieldNames ? `<th class="dbx-grid-snapshot__cell dbx-grid-snapshot__cell--header" style="background:${GRID_SNAPSHOT_HEADER[appearance]};color:${GRID_SNAPSHOT_TEXT[appearance]};padding:${headerPadding}"><span class="dbx-grid-snapshot__column"><span class="dbx-grid-snapshot__column-name">${escapeHtml(options.fieldNameLabel ?? "Field Names")}</span></span></th>` : ""}${source.rows.map((_, rowIndex) => `<th class="dbx-grid-snapshot__cell dbx-grid-snapshot__cell--header" style="background:${GRID_SNAPSHOT_HEADER[appearance]};color:${GRID_SNAPSHOT_TEXT[appearance]};padding:${headerPadding}"><span class="dbx-grid-snapshot__column"><span class="dbx-grid-snapshot__column-name">#${rowIndex + 1}</span></span></th>`).join("")}</tr></thead>`
    : showFieldNames
      ? `<thead><tr>${rowNumberHeader}${source.columns.map((column, columnIndex) => renderFieldCell(column, columnIndex, "th")).join("")}</tr></thead>`
      : "";
  const displayRows: GridSnapshotCellValue[][] = transpose ? source.columns.map((_, columnIndex) => source.rows.map((row) => row[columnIndex] ?? null)) : source.rows;
  const body = displayRows
    .map(
      (row, rowIndex) =>
        `<tr style="background:${rowIndex % 2 === 1 ? GRID_SNAPSHOT_STRIPED_ROW[appearance] : GRID_SNAPSHOT_BACKGROUND[appearance]}">${showRowNumbers ? `<td class="dbx-grid-snapshot__cell dbx-grid-snapshot__cell--row-number" style="background:${GRID_SNAPSHOT_ROW_NUMBER[appearance]};color:${GRID_SNAPSHOT_MUTED[appearance]};padding:${cellPadding}">${rowIndex + 1}</td>` : ""}${transpose && showFieldNames ? renderFieldCell(source.columns[rowIndex] ?? "", rowIndex, "td") : ""}${row
          .map((value) => {
            const nullClass = value === null ? " dbx-grid-snapshot__cell--null" : "";
            return `<td class="dbx-grid-snapshot__cell${wrapCells ? " dbx-grid-snapshot__cell--wrapped" : ""}${nullClass}" style="color:${value === null ? GRID_SNAPSHOT_MUTED[appearance] : GRID_SNAPSHOT_TEXT[appearance]};padding:${cellPadding}">${escapeHtml(formatGridSnapshotCell(value))}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  const bar = options.showTrafficLights !== false || source.title ? renderSnapshotBar(source.title, appearance, options.showTrafficLights !== false) : "";
  return `<style>${GRID_SNAPSHOT_CSS}</style><div class="dbx-grid-snapshot" data-snapshot-appearance="${appearance}" style="background:${GRID_SNAPSHOT_BACKGROUND[appearance]};font-size:${fontSize};color:${GRID_SNAPSHOT_TEXT[appearance]};--dbx-grid-snapshot-border:${GRID_SNAPSHOT_BORDER[appearance]}">${bar}<table class="dbx-grid-snapshot__table">${header}<tbody>${body}</tbody></table></div>`;
}

export { snapshotElementToPng, copyPngDataUrlToClipboard, savePngDataUrlToFile };
