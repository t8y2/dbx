import type { AppSupportInfo } from "@/lib/backend/tauri";

export interface AppSupportInfoLabels {
  appVersion: string;
  runtime: string;
  runtimeDesktop: string;
  runtimeWeb: string;
  operatingSystem: string;
  architecture: string;
  unknown: string;
}

export interface AppSupportInfoRow {
  key: keyof Pick<AppSupportInfoLabels, "appVersion" | "runtime" | "operatingSystem" | "architecture">;
  label: string;
  value: string;
}

export function normalizeSupportInfoVersion(version: string | null | undefined, unknownLabel: string): string {
  const trimmed = version?.trim();
  if (!trimmed) return unknownLabel;
  return trimmed.startsWith("v") || trimmed.startsWith("V") ? `v${trimmed.slice(1)}` : `v${trimmed}`;
}

export function formatSupportInfoRuntime(runtime: AppSupportInfo["runtime"], labels: AppSupportInfoLabels): string {
  if (runtime === "desktop") return labels.runtimeDesktop;
  if (runtime === "web") return labels.runtimeWeb;
  return labels.unknown;
}

export function formatSupportInfoOperatingSystem(info: AppSupportInfo, unknownLabel: string): string {
  const name = info.osName?.trim();
  const version = info.osVersion?.trim();
  if (!name && !version) return unknownLabel;
  return [name, version].filter(Boolean).join(" ");
}

export function buildAppSupportInfoRows(info: AppSupportInfo, labels: AppSupportInfoLabels): AppSupportInfoRow[] {
  return [
    {
      key: "appVersion",
      label: labels.appVersion,
      value: normalizeSupportInfoVersion(info.appVersion, labels.unknown),
    },
    {
      key: "runtime",
      label: labels.runtime,
      value: formatSupportInfoRuntime(info.runtime, labels),
    },
    {
      key: "operatingSystem",
      label: labels.operatingSystem,
      value: formatSupportInfoOperatingSystem(info, labels.unknown),
    },
    {
      key: "architecture",
      label: labels.architecture,
      value: info.arch?.trim() || labels.unknown,
    },
  ];
}

export function formatAppSupportInfoForClipboard(info: AppSupportInfo, labels: AppSupportInfoLabels): string {
  return buildAppSupportInfoRows(info, labels)
    .map((row) => `${row.label}: ${row.value}`)
    .join("\n");
}
