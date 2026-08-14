import { describe, expect, it } from "vitest";
import { buildNatsPublishRequest, parseNatsHeaders, presentNatsMessage } from "@/lib/nats/messagePresentation";

describe("NATS message presentation", () => {
  it("formats JSON payloads while retaining a text fallback", () => {
    const json = presentNatsMessage({
      subject: "orders.created",
      headers: [],
      payloadBase64: "eyJvayI6dHJ1ZX0=",
      payloadText: '{"ok":true}',
      receivedAtMs: 0,
      sizeBytes: 11,
    });
    expect(json).toMatchObject({ mode: "json", payload: '{\n  "ok": true\n}', receivedAt: "1970-01-01T00:00:00.000Z" });

    const binary = presentNatsMessage({
      subject: "orders.created",
      headers: [],
      payloadBase64: "AAE=",
      receivedAtMs: 0,
      sizeBytes: 2,
    });
    expect(binary).toMatchObject({ mode: "base64", payload: "AAE=", sizeLabel: "2 B" });
  });

  it("preserves repeated headers and builds a bounded publish DTO", () => {
    expect(parseNatsHeaders("Nats-Msg-Id: 1\nNats-Msg-Id: 2")).toEqual([
      { key: "Nats-Msg-Id", value: "1" },
      { key: "Nats-Msg-Id", value: "2" },
    ]);
    expect(buildNatsPublishRequest(" orders.created ", " _INBOX.reply ", "X-Test: yes", '{"ok":true}', "json")).toEqual({
      subject: "orders.created",
      reply: "_INBOX.reply",
      headers: [{ key: "X-Test", value: "yes" }],
      payloadBase64: "eyJvayI6dHJ1ZX0=",
    });
  });

  it("rejects malformed headers, JSON, and non-canonical Base64 before publishing", () => {
    expect(() => parseNatsHeaders("No separator")).toThrow("Key: Value");
    expect(() => buildNatsPublishRequest("orders.created", "", "", "{", "json")).toThrow("valid JSON");
    expect(() => buildNatsPublishRequest("orders.created", "", "", "YWJj=", "base64")).toThrow("canonical Base64");
  });
});
