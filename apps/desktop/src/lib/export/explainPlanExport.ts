import type { ExplainPlanNode, ParsedExplainPlan } from "@/lib/diagram/explainPlan";
import { formatExplainPlanDetails } from "@/lib/diagram/explainPlan";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useSettingsStore } from "@/stores/settingsStore";
import { csvNullLiteralForMode } from "./csvNullMode";
import { svgToPngBlob } from "./diagramFormats";
import { buildExplainPlanSvg, type ExplainPlanSvgLabels } from "./explainPlanSvgExport";
import { promptExportSavePath } from "./exportPath";
import { saveDiagramBinaryExport, saveDiagramTextExport } from "./saveDiagramExport";

export type ExplainPlanExportFormat = "svg" | "png" | "html" | "csv" | "xlsx";

export type ExplainPlanDiagramExportLabels = Omit<ExplainPlanSvgLabels, "title">;

export const EXPLAIN_PLAN_EXPORT_COLUMN_KEYS = ["explain.node", "explain.relation", "explain.index", "explain.cost", "explain.rows", "explain.details"] as const;

/** Export the complete Summary, including children hidden by the current view. */
export function explainPlanExportRows(nodes: ExplainPlanNode[], estimatedTimeLabel: string): string[][] {
  const rows: string[][] = [];
  function visit(node: ExplainPlanNode, depth: number) {
    rows.push([`${"  ".repeat(depth)}${node.title}`, node.relation || "-", node.index || "-", node.cost || "-", node.rows || "-", formatExplainPlanDetails(node, estimatedTimeLabel).join("; ") || "-"]);
    node.children.forEach((child) => visit(child, depth + 1));
  }
  nodes.forEach((node) => visit(node, 0));
  return rows;
}

export async function saveExplainPlanExport(plan: ParsedExplainPlan, format: ExplainPlanExportFormat, columns: string[], estimatedTimeLabel: string, title: string, diagramLabels?: ExplainPlanDiagramExportLabels): Promise<boolean> {
  // Materialize before awaiting the save dialog: another query may replace the plan.
  const rows = explainPlanExportRows(plan.nodes, estimatedTimeLabel);
  if (!rows.length) return false;
  const defaultPath = `explain-plan-${plan.databaseType}.${format}`;
  if (format === "svg" || format === "png") {
    const svg = buildExplainPlanSvg(plan.nodes, {
      title,
      cost: diagramLabels?.cost ?? "Cost",
      estimatedRows: diagramLabels?.estimatedRows ?? "Estimated rows",
      legendHeat: diagramLabels?.legendHeat ?? "Cost heat",
      legendEdge: diagramLabels?.legendEdge ?? "Edge thickness = estimated rows",
    });
    if (format === "svg") return saveDiagramTextExport(defaultPath, svg, "svg");
    const png = await svgToPngBlob(svg, 2);
    return saveDiagramBinaryExport(defaultPath, png, "png");
  }

  const { csvQuoteMode, csvNullMode } = useSettingsStore().editorSettings;
  let path = defaultPath;
  if (isTauriRuntime()) {
    const selectedPath = await promptExportSavePath({
      defaultFileName: path,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!selectedPath) return false;
    path = selectedPath;
  }

  if (format === "csv") {
    await api.exportQueryResultCsv(path, columns, rows, csvQuoteMode, csvNullLiteralForMode(csvNullMode));
  } else if (format === "xlsx") {
    // Keep engine-native costs/rows (e.g. "148 (0)" and "0.29..1830.12") as text.
    await api.exportQueryResultXlsx(
      path,
      "Explain Plan",
      columns,
      columns.map(() => "TEXT"),
      undefined,
      rows,
    );
  } else {
    await api.exportQueryResultHtml(path, title, columns, rows);
  }
  return true;
}
