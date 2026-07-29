import type { CellValue } from "@/lib/dataGrid/cellValue";
import type { HBaseCellInput, HBaseValueEncoding } from "@/types/hbase";

export interface HBaseEncodedText {
  value: string;
  encoding: HBaseValueEncoding;
}

export function encodeHBaseTextInput(value: string): HBaseEncodedText {
  return value.startsWith("base64:") ? { value: value.slice(7), encoding: "base64" } : { value, encoding: "utf8" };
}

export function hbaseCellInput(column: string, value: CellValue): HBaseCellInput {
  const encoded = encodeHBaseTextInput(value == null ? "" : String(value));
  return { column, value: encoded.value, valueEncoding: encoded.encoding };
}
