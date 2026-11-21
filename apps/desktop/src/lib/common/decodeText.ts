/**
 * Decode an imported connection file's bytes to text.
 *
 * Navicat 17 exports on macOS can arrive as UTF-16 (with or without BOM)
 * while the import path historically decoded everything as UTF-8, which
 * turned the XML into mojibake and surfaced as "Invalid Navicat connection
 * file" (#10666). Sniff the BOM first, then fall back to a null-byte
 * heuristic for BOM-less UTF-16; plain UTF-8 (including JSON payloads)
 * decodes exactly as before.
 */
export function decodeImportFileText(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return stripBom(new TextDecoder("utf-8").decode(bytes.subarray(3)));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return stripBom(new TextDecoder("utf-16le").decode(bytes.subarray(2)));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return stripBom(new TextDecoder("utf-16be").decode(bytes.subarray(2)));
  }
  // BOM-less UTF-16: ASCII-range text leaves a null in every other byte.
  // `<C` is `<\0C\0` in LE (nulls on odd indices) and `\0<\0C` in BE.
  const sample = bytes.subarray(0, 64);
  let evenNulls = 0;
  let oddNulls = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) {
      if (i % 2 === 0) evenNulls++;
      else oddNulls++;
    }
  }
  if (oddNulls > 0 && oddNulls >= evenNulls) {
    return stripBom(new TextDecoder("utf-16le").decode(bytes));
  }
  if (evenNulls > 0 && evenNulls > oddNulls) {
    return stripBom(new TextDecoder("utf-16be").decode(bytes));
  }
  return stripBom(new TextDecoder("utf-8").decode(bytes));
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
