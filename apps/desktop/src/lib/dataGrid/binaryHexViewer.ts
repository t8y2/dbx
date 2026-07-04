export interface BinaryHexViewRow {
  offset: string;
  hex: string;
  ascii: string;
}

const BYTES_PER_ROW = 16;

function formatHexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

function formatAsciiByte(value: number): string {
  return value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : ".";
}

export function buildBinaryHexViewRows(bytes: Uint8Array): BinaryHexViewRow[] {
  const rows: BinaryHexViewRow[] = [];
  for (let offset = 0; offset < bytes.length; offset += BYTES_PER_ROW) {
    const slice = bytes.slice(offset, offset + BYTES_PER_ROW);
    rows.push({
      offset: offset.toString(16).toUpperCase().padStart(8, "0"),
      hex: Array.from(slice, formatHexByte).join(" "),
      ascii: Array.from(slice, formatAsciiByte).join(""),
    });
  }
  return rows;
}
