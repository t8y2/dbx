export const DATA_TAB_REUSE_MODES = ["always-new", "same-table", "active-tab"] as const;

export type DataTabReuseMode = (typeof DATA_TAB_REUSE_MODES)[number];

export const DEFAULT_DATA_TAB_REUSE_MODE: DataTabReuseMode = "same-table";

const dataTabReuseModes = new Set<DataTabReuseMode>(DATA_TAB_REUSE_MODES);

export function normalizeDataTabReuseMode(value: unknown, legacyReuseDataTab?: unknown): DataTabReuseMode {
  if (typeof value === "string" && dataTabReuseModes.has(value as DataTabReuseMode)) return value as DataTabReuseMode;
  if (legacyReuseDataTab === true) return "same-table";
  if (legacyReuseDataTab === false) return "always-new";
  return DEFAULT_DATA_TAB_REUSE_MODE;
}
