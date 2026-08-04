import { compactLocalTimestamp, sanitizeExportBaseName } from "./saveTextFile";

export interface BuildAiAnalysisExportInput {
  connectionName?: string;
  content: string;
  analysisLabel: string;
  dateLabel: string;
}

export interface BuildAiAnalysisExportOutput {
  markdown: string;
  defaultFileName: string;
}

export function buildAiAnalysisExport(input: BuildAiAnalysisExportInput): BuildAiAnalysisExportOutput | null {
  if (!input.content.trim()) return null;

  const rawName = input.connectionName || "";
  const sanitizedName = sanitizeExportBaseName(rawName) || "ai";
  const displayName = rawName || "AI";

  const headerLines = [`# ${displayName} · ${input.analysisLabel}`, `${input.dateLabel}`, ""];
  const markdown = headerLines.join("\n") + input.content;

  const defaultFileName = `${sanitizedName}_${compactLocalTimestamp()}.md`;

  return { markdown, defaultFileName };
}
