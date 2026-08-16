import { describe, expect, it } from "vitest";
import { availableViewModes, buildNatsPublishRequest, formatHeadersForCopy, isWildcardSubject, parseNatsHeaders, presentNatsMessage } from "@/lib/nats/messagePresentation";

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

  it("detects wildcard subjects (publish must use a concrete subject)", () => {
    expect(isWildcardSubject("orders.>")).toBe(true);
    expect(isWildcardSubject("orders.*.created")).toBe(true);
    expect(isWildcardSubject("orders.created")).toBe(false);
    expect(isWildcardSubject("")).toBe(false);
  });

  it("offers view modes by payload decodability and honors an explicit mode", () => {
    const textMessage = { subject: "s", headers: [], payloadBase64: "eyJvayI6dHJ1ZX0=", payloadText: '{"ok":true}', receivedAtMs: 0, sizeBytes: 11 };
    expect(availableViewModes(textMessage)).toEqual(["auto", "json", "text", "base64"]);
    expect(presentNatsMessage(textMessage, "text")).toMatchObject({ mode: "text", payload: '{"ok":true}' });
    expect(presentNatsMessage(textMessage, "base64")).toMatchObject({ mode: "base64", payload: "eyJvayI6dHJ1ZX0=" });
    expect(presentNatsMessage(textMessage, "json").mode).toBe("json");

    const binaryMessage = { subject: "s", headers: [], payloadBase64: "AAE=", receivedAtMs: 0, sizeBytes: 2 };
    expect(availableViewModes(binaryMessage)).toEqual(["base64"]);
    // A requested text/json mode cannot apply to non-UTF-8 payloads → stays Base64.
    expect(presentNatsMessage(binaryMessage, "text")).toMatchObject({ mode: "base64", payload: "AAE=" });
  });

  it("serializes headers for clipboard copy, preserving order and duplicates", () => {
    expect(
      formatHeadersForCopy([
        { key: "Nats-Msg-Id", value: "1" },
        { key: "Nats-Msg-Id", value: "2" },
        { key: "X-Empty", value: "" },
      ]),
    ).toBe("Nats-Msg-Id: 1\nNats-Msg-Id: 2\nX-Empty: ");
    expect(formatHeadersForCopy([])).toBe("");
  });
});
