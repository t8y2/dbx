export function sqlFileProgressPercent(status: string, bytesRead?: number, totalBytes?: number): number | null {
  if (status.toLowerCase() === "done") return 100;
  if (bytesRead === undefined || totalBytes === undefined || !Number.isFinite(bytesRead) || !Number.isFinite(totalBytes) || bytesRead < 0 || totalBytes <= 0) return null;
  return Math.min(99, Math.floor((bytesRead / totalBytes) * 100));
}

export function formatSqlFileBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${unitIndex === 0 ? value : value.toFixed(1)} ${units[unitIndex]}`;
}
