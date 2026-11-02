import { describe, expect, it } from "vitest";
import { decodeThriftBinary, decodeThriftBinaryBase64, formatMqMessagePayload } from "@/lib/mq/thriftBinary";

function toBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

describe("thriftBinary (thrift.TBinaryProtocol)", () => {
  it("decodes strict VERSION_1 RPC CALL messages with nested fields and containers", () => {
    // VERSION_1 | CALL (0x80010001), method="createOrder", seqId=12,
    // field 1 (STRING) = "ord-9", field 2 (I32) = 250, field 3 (BOOL) = true,
    // field 4 (LIST<I16>) = [10, 20], field 5 (MAP<STRING, I32>) = {"qty": 3}, STOP
    const payload = new Uint8Array([
      0x80,
      0x01,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x0b,
      ...new TextEncoder().encode("createOrder"),
      0x00,
      0x00,
      0x00,
      0x0c,
      0x0b,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x05,
      ...new TextEncoder().encode("ord-9"),
      0x08,
      0x00,
      0x02,
      0x00,
      0x00,
      0x00,
      0xfa,
      0x02,
      0x00,
      0x03,
      0x01,
      0x0f,
      0x00,
      0x04,
      0x06,
      0x00,
      0x00,
      0x00,
      0x02,
      0x00,
      0x0a,
      0x00,
      0x14,
      0x0d,
      0x00,
      0x05,
      0x0b,
      0x08,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x03,
      ...new TextEncoder().encode("qty"),
      0x00,
      0x00,
      0x00,
      0x03,
      0x00,
    ]);

    const result = decodeThriftBinary(payload);
    expect(result?.value).toEqual({
      method: "createOrder",
      type: "CALL",
      seqId: 12,
      fields: {
        "1": "ord-9",
        "2": 250,
        "3": true,
        "4": [10, 20],
        "5": { qty: 3 },
      },
    });
  });

  it("decodes TFramedTransport-prefixed and raw TSerializer structs", () => {
    const structBytes = [0x0b, 0x00, 0x01, 0x00, 0x00, 0x00, 0x05, ...new TextEncoder().encode("hello"), 0x0c, 0x00, 0x02, 0x08, 0x00, 0x01, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00];
    const framed = [0x00, 0x00, 0x00, structBytes.length, ...structBytes];

    expect(decodeThriftBinaryBase64(toBase64(framed))?.value).toBeUndefined();
    expect(decodeThriftBinaryBase64(toBase64(framed), { allowRawStructSniff: true })?.value).toEqual({
      "1": "hello",
      "2": { "1": 7 },
    });

    // Raw (headerless) TSerializer structs are the same opt-in heuristic:
    // without the flag the decoder returns null instead of guessing at
    // arbitrary binary.
    expect(decodeThriftBinaryBase64(toBase64(structBytes))?.value).toBeUndefined();
    expect(decodeThriftBinaryBase64(toBase64(structBytes), { allowRawStructSniff: true })?.value).toEqual({
      "1": "hello",
      "2": { "1": 7 },
    });
  });

  it("formats RabbitMQ TBinaryProtocol messages even when Go utf8.Valid passed control bytes", () => {
    const rawBytes = [0x0b, 0x00, 0x01, 0x00, 0x00, 0x00, 0x05, ...new TextEncoder().encode("hello"), 0x00];
    const rawTextWithControls = String.fromCharCode(...rawBytes);

    expect(
      formatMqMessagePayload(
        {
          payloadBase64: toBase64(rawBytes),
          payloadText: rawTextWithControls,
        },
        { allowRawStructSniff: true },
      ),
    ).toBe('{\n  "1": "hello"\n}');
  });

  it("preserves plain text and non-Thrift base64 fallbacks", () => {
    expect(formatMqMessagePayload({ payloadBase64: "", payloadText: "existing message" })).toBe("existing message");
    expect(formatMqMessagePayload({ payloadBase64: "AAE=", payloadText: undefined })).toBe("AAE=");
  });
});
