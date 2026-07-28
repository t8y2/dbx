export type HBaseValueEncoding = "utf8" | "base64";

export interface HBaseColumnFamily {
  name: string;
  properties: Record<string, string>;
}

export interface HBaseTableSchema {
  name: string;
  columnFamilies: HBaseColumnFamily[];
  properties: Record<string, string>;
}

export interface HBaseCell {
  column: string;
  value: string;
  valueEncoding: HBaseValueEncoding;
  valueBase64: string;
  timestamp?: number;
}

export interface HBaseRow {
  rowKey: string;
  rowKeyEncoding: HBaseValueEncoding;
  rowKeyBase64: string;
  cells: HBaseCell[];
}

export interface HBaseScanResult {
  rows: HBaseRow[];
  truncated: boolean;
}

export interface HBaseCellInput {
  column: string;
  value: string;
  valueEncoding?: HBaseValueEncoding;
}

export interface HBasePutRowInput {
  rowKey: string;
  rowKeyEncoding?: HBaseValueEncoding;
  cells: HBaseCellInput[];
}
