import type { DataTransferFailure, SqlFileFailure } from "@/composables/useExportTracker";

export function dataTransferFailureCopyText(failure: DataTransferFailure): string {
  return `${failure.table}\n${failure.error}`;
}

export function sqlFileFailureCopyText(failure: SqlFileFailure, translatedError: string): string {
  const heading = `#${failure.statementIndex}${failure.fileName ? ` ${failure.fileName}` : ""}`;
  return [heading, failure.statementSummary || undefined, translatedError].filter((line): line is string => line !== undefined).join("\n");
}
