import { describe, expect, it } from "vitest";
import { CELL_TRANSFORM_FORMAT_CHOICES, CELL_TRANSFORM_MAX_BINARY_INPUT, CELL_TRANSFORM_MAX_INPUT, transformCellValue } from "@/lib/dataGrid/cellValueTransform";

function base64Of(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0, 1, 2];
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d];

describe("transformCellValue base64Image", () => {
  it("decodes a png payload and labels its format", () => {
    const result = transformCellValue(base64Of(PNG_HEADER), { kind: "base64Image" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("binary" in result && result.binary).toMatchObject({ mimeType: "image/png", extension: "png", isImage: true, recognized: true });
    expect("binary" in result && Array.from(result.binary.bytes)).toEqual(PNG_HEADER);
  });

  it("accepts jpeg and webp via magic bytes", () => {
    const webp = [0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 9];
    expect(transformCellValue(base64Of(JPEG_HEADER), { kind: "base64Image" })).toMatchObject({ ok: true, binary: { extension: "jpg", recognized: true } });
    expect(transformCellValue(base64Of(webp), { kind: "base64Image" })).toMatchObject({ ok: true, binary: { extension: "webp", recognized: true } });
  });

  it("labels any detected format instead of rejecting non-image bytes", () => {
    expect(transformCellValue(base64Of(PDF_HEADER), { kind: "base64Image" })).toMatchObject({ ok: true, binary: { mimeType: "application/pdf", extension: "pdf", isImage: false, recognized: true } });
  });

  it("marks undetectable payloads unrecognized with a bin fallback", () => {
    expect(transformCellValue(base64Of([1, 2, 3, 4]), { kind: "base64Image" })).toMatchObject({ ok: true, binary: { mimeType: "application/octet-stream", extension: "bin", isImage: false, recognized: false } });
  });

  it("rejects malformed base64", () => {
    expect(transformCellValue("not base64!!", { kind: "base64Image" })).toEqual({ ok: false, error: "invalidBase64" });
  });

  it("normalizes unpadded, base64url, and whitespace-wrapped payloads", () => {
    const payload = base64Of(PNG_HEADER);
    expect(transformCellValue(payload.replace(/=+$/, ""), { kind: "base64Image" })).toMatchObject({ ok: true, binary: { extension: "png" } });
    expect(transformCellValue(payload.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), { kind: "base64Image" })).toMatchObject({ ok: true, binary: { extension: "png" } });
    const wrapped = `${payload.slice(0, 8)}\n ${payload.slice(8, 20)}\t${payload.slice(20)}`;
    expect(transformCellValue(wrapped, { kind: "base64Image" })).toMatchObject({ ok: true, binary: { extension: "png" } });
    const odd = base64Of([0xff, 0xd8, 0xff, 0xe0]).replace(/=+$/, "");
    expect(transformCellValue(odd, { kind: "base64Image" })).toMatchObject({ ok: true, binary: { extension: "jpg" } });
  });

  it("tolerates a truncated payload ending in one orphan character", () => {
    const result = transformCellValue(`${base64Of(PNG_HEADER)}A`, { kind: "base64Image" });
    expect(result).toMatchObject({ ok: true, binary: { extension: "png" } });
    if (result.ok && "binary" in result) expect(Array.from(result.binary.bytes)).toEqual(PNG_HEADER);
  });

  it("applies the binary input gate instead of the text gate", () => {
    expect(transformCellValue("A".repeat(CELL_TRANSFORM_MAX_BINARY_INPUT + 4), { kind: "base64Image" })).toEqual({ ok: false, error: "tooLarge" });
    // Past the text gate but within the binary gate: text kinds reject, binary kinds decode.
    const overTextInput = "AAAA".repeat(CELL_TRANSFORM_MAX_INPUT / 4 + 1);
    expect(transformCellValue(overTextInput, { kind: "json" })).toEqual({ ok: false, error: "tooLarge" });
    expect(transformCellValue(overTextInput, { kind: "base64File" }).ok).toBe(true);
  });
});

describe("transformCellValue base64File", () => {
  it("labels recognized non-image formats", () => {
    expect(transformCellValue(base64Of(PDF_HEADER), { kind: "base64File" })).toMatchObject({ ok: true, binary: { mimeType: "application/pdf", extension: "pdf", isImage: false, recognized: true } });
    const zip = [0x50, 0x4b, 0x03, 0x04, 20];
    expect(transformCellValue(base64Of(zip), { kind: "base64File" })).toMatchObject({ ok: true, binary: { extension: "zip", recognized: true } });
  });

  it("falls back to bin for unknown bytes and keeps images", () => {
    expect(transformCellValue(base64Of([1, 2, 3, 4]), { kind: "base64File" })).toMatchObject({ ok: true, binary: { mimeType: "application/octet-stream", extension: "bin", recognized: false } });
    expect(transformCellValue(base64Of(PNG_HEADER), { kind: "base64File" })).toMatchObject({ ok: true, binary: { extension: "png", isImage: true, recognized: true } });
  });
});

describe("transformCellValue format choices", () => {
  it("offers every detected format plus txt and bin for manual selection", () => {
    expect(CELL_TRANSFORM_FORMAT_CHOICES.map((format) => format.extension)).toEqual(["png", "jpg", "gif", "webp", "bmp", "ico", "pdf", "zip", "gz", "txt", "bin"]);
  });
});

describe("transformCellValue text kinds unchanged", () => {
  it("base64Decode still rejects binary payloads", () => {
    expect(transformCellValue(base64Of(PNG_HEADER), { kind: "base64Decode" })).toEqual({ ok: false, error: "invalidBase64" });
    const utf8Base64 = btoa(String.fromCharCode(...new TextEncoder().encode("héllo")));
    expect(transformCellValue(utf8Base64, { kind: "base64Decode" })).toMatchObject({ ok: true, text: "héllo" });
  });

  it("base64Decode accepts unpadded and base64url payloads", () => {
    const utf8Base64 = btoa(String.fromCharCode(...new TextEncoder().encode("héllo")));
    expect(transformCellValue(utf8Base64.replace(/=+$/, ""), { kind: "base64Decode" })).toMatchObject({ ok: true, text: "héllo" });
    expect(transformCellValue(` ${utf8Base64.slice(0, 4)}\n${utf8Base64.slice(4)} `, { kind: "base64Decode" })).toMatchObject({ ok: true, text: "héllo" });
  });
});

describe("transformCellValue data URI prefixes", () => {
  it("strips data:image/...;base64, before decoding for image and text kinds", () => {
    const png = base64Of(PNG_HEADER);
    expect(transformCellValue(`data:image/png;base64,${png}`, { kind: "base64Image" })).toMatchObject({ ok: true, binary: { extension: "png", isImage: true, recognized: true } });
    expect(transformCellValue(`data:;base64,AA==`, { kind: "base64File" })).toMatchObject({ ok: true, binary: { extension: "bin", recognized: false } });
    const utf8Base64 = btoa(String.fromCharCode(...new TextEncoder().encode("hello")));
    expect(transformCellValue(`data:text/plain;charset=utf-8;base64,${utf8Base64}`, { kind: "base64Decode" })).toMatchObject({ ok: true, text: "hello" });
  });

  it("labels unknown magic bytes from the declared mime", () => {
    const weird = base64Of([1, 2, 3, 4, 5, 6]);
    const result = transformCellValue(`data:application/pdf;base64,${weird}`, { kind: "base64File" });
    expect(result).toMatchObject({ ok: true, binary: { mimeType: "application/pdf", extension: "pdf", isImage: false, recognized: true } });
    expect(transformCellValue(`data:image/png;base64,${weird}`, { kind: "base64File" })).toMatchObject({ ok: true, binary: { extension: "png", isImage: true, recognized: true } });
    expect(transformCellValue(`data:image/png;base64,${weird}`, { kind: "base64Image" })).toMatchObject({ ok: true, binary: { extension: "png", isImage: true, recognized: true } });
    // Unknown declared mime keeps the unrecognized .bin fallback for both binary kinds.
    expect(transformCellValue(`data:application/x-unknown;base64,${weird}`, { kind: "base64File" })).toMatchObject({ ok: true, binary: { extension: "bin", recognized: false } });
    expect(transformCellValue(`data:application/x-unknown;base64,${weird}`, { kind: "base64Image" })).toMatchObject({ ok: true, binary: { extension: "bin", recognized: false } });
  });

  it("reports the detected format for base64Image when bytes are a known non-image", () => {
    expect(transformCellValue(`data:image/png;base64,${base64Of(PDF_HEADER)}`, { kind: "base64Image" })).toMatchObject({ ok: true, binary: { extension: "pdf", isImage: false, recognized: true } });
  });
});
