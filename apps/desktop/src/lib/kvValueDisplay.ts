import type { KvKeyMetadata } from "@/lib/api";

export interface PrettyPrintJsonResult {
  ok: boolean;
  value?: string;
  error?: "invalid_json";
}

export interface DisplayItem {
  label: string;
  value: string;
}

export interface ZooKeeperSummaryLabels {
  revision?: string;
  version?: string;
  lease?: string;
  size?: string;
}

export function prettyPrintJsonText(text: string): PrettyPrintJsonResult {
  try {
    return { ok: true, value: JSON.stringify(JSON.parse(text), null, 2) };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}

function valueLabel(value: number | null | undefined): string {
  return value == null ? "-" : String(value);
}

function byteLabel(value: number | null | undefined): string {
  return value == null ? "- B" : `${value} B`;
}

function hexLabel(value: number | null | undefined): string {
  if (value == null) return "-";
  return `0x${Math.trunc(value).toString(16)}`;
}

function dateTimeLabel(value: number | null | undefined): string {
  if (value == null) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function metadataNumber(metadata: KvKeyMetadata | null | undefined, key: keyof KvKeyMetadata): number | null | undefined {
  return metadata?.[key] as number | null | undefined;
}

export function formatZooKeeperSummaryBadges(metadata: KvKeyMetadata | null | undefined, labels: ZooKeeperSummaryLabels = {}): DisplayItem[] {
  return [
    { label: labels.revision ?? "rev", value: valueLabel(metadata?.modRevision ?? metadata?.mzxid) },
    { label: labels.version ?? "ver", value: valueLabel(metadata?.version) },
    { label: labels.lease ?? "lease", value: valueLabel(metadata?.lease) },
    { label: labels.size ?? "size", value: byteLabel(metadata?.valueSize ?? metadata?.dataLength) },
  ];
}

export function formatZooKeeperMetadataRows(metadata: KvKeyMetadata | null | undefined): DisplayItem[] {
  return [
    { label: "ephemeralOwner", value: hexLabel(metadata?.ephemeralOwner) },
    { label: "mtime", value: dateTimeLabel(metadata?.mtime) },
    { label: "ctime", value: dateTimeLabel(metadata?.ctime) },
    { label: "mZxid", value: hexLabel(metadata?.mzxid) },
    { label: "pZxid", value: hexLabel(metadataNumber(metadata, "pzxid")) },
    { label: "cZxid", value: hexLabel(metadata?.czxid) },
    { label: "dataLength", value: valueLabel(metadata?.dataLength) },
    { label: "numChildren", value: valueLabel(metadata?.numChildren) },
    { label: "dataVersion", value: valueLabel(metadata?.version) },
    { label: "aclVersion", value: valueLabel(metadata?.aversion) },
    { label: "cVersion", value: valueLabel(metadata?.cversion) },
  ];
}
