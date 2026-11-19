import { describe, expect, it } from "vitest";
import { decodeImportFileText } from "@/lib/common/decodeText";

function utf16Bytes(text: string, littleEndian: boolean, bom: boolean): ArrayBuffer {
  const out: number[] = [];
  if (bom) out.push(...(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]));
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (littleEndian) out.push(code & 0xff, (code >> 8) & 0xff);
    else out.push((code >> 8) & 0xff, code & 0xff);
  }
  return new Uint8Array(out).buffer as ArrayBuffer;
}

function utf8Bytes(text: string, bom: boolean): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  if (!bom) return encoded.buffer as ArrayBuffer;
  const out = new Uint8Array(encoded.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(encoded, 3);
  return out.buffer as ArrayBuffer;
}

const xml = `<Connections><Connection ConnType="MYSQL" Name="local" Host="127.0.0.1" Port="3306" /></Connections>`;

describe("decodeImportFileText", () => {
  it("decodes plain UTF-8 unchanged", () => {
    expect(decodeImportFileText(utf8Bytes(xml, false))).toBe(xml);
  });

  it("strips a UTF-8 BOM", () => {
    expect(decodeImportFileText(utf8Bytes(xml, true))).toBe(xml);
  });

  it("decodes UTF-16LE with BOM (#10666 Navicat 17 macOS export)", () => {
    expect(decodeImportFileText(utf16Bytes(xml, true, true))).toBe(xml);
  });

  it("decodes UTF-16BE with BOM", () => {
    expect(decodeImportFileText(utf16Bytes(xml, false, true))).toBe(xml);
  });

  it("decodes BOM-less UTF-16LE via the null-byte heuristic", () => {
    expect(decodeImportFileText(utf16Bytes(xml, true, false))).toBe(xml);
  });

  it("decodes BOM-less UTF-16BE via the null-byte heuristic", () => {
    expect(decodeImportFileText(utf16Bytes(xml, false, false))).toBe(xml);
  });

  it("decodes an empty file to an empty string", () => {
    expect(decodeImportFileText(new ArrayBuffer(0))).toBe("");
  });

  it("accepts Uint8Array input (Tauri readFile shape)", () => {
    expect(decodeImportFileText(new Uint8Array(utf8Bytes(xml, false)))).toBe(xml);
  });
});
