import { describe, expect, it, vi } from "vitest";
import { clipboardApiKeyCandidate, importClipboardApiKeyAfterConfirmation, parseAiConfigDeepLink } from "@/lib/ai/aiConfigDeepLink";

function buildLink(params: Record<string, string>): string {
  const url = new URL("dbx://settings/ai/new");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

describe("AI configuration deep links", () => {
  it("parses a public OpenAI-compatible configuration without a secret", () => {
    const draft = parseAiConfigDeepLink(
      buildLink({
        v: "1",
        name: "Example AI",
        provider: "openai-compatible",
        endpoint: "https://api.example.com/v1/",
        model: "example-model",
        auth: "bearer",
        api: "responses",
        clipboard: "prompt",
      }),
    );

    expect(draft).toEqual({
      name: "Example AI",
      provider: "openai-compatible",
      endpoint: "https://api.example.com/v1",
      model: "example-model",
      authMethod: "bearer",
      apiStyle: "responses",
      promptForClipboardApiKey: true,
    });
  });

  it("uses protocol defaults when auth and API style are omitted", () => {
    expect(
      parseAiConfigDeepLink(
        buildLink({
          name: "Example Messages API",
          provider: "anthropic-compatible",
          endpoint: "https://messages.example.com/v1/messages",
          model: "example-model",
        }),
      ),
    ).toMatchObject({ authMethod: "api-key", apiStyle: "anthropic-messages", promptForClipboardApiKey: false });

    expect(
      parseAiConfigDeepLink(
        buildLink({
          name: "Example Custom Messages API",
          provider: "custom",
          endpoint: "https://messages.example.com/v1/messages",
          model: "example-model",
          api: "anthropic-messages",
        }),
      ),
    ).toMatchObject({ authMethod: "api-key", apiStyle: "anthropic-messages" });
  });

  it("ignores unrelated DBX routes", () => {
    expect(parseAiConfigDeepLink("dbx://open")).toBeNull();
    expect(parseAiConfigDeepLink("dbx://connection/new?type=mysql")).toBeNull();
  });

  it("rejects secrets and ambiguous parameters in the URL", () => {
    expect(() =>
      parseAiConfigDeepLink(
        buildLink({
          name: "Example AI",
          provider: "openai-compatible",
          endpoint: "https://api.example.com/v1",
          model: "example-model",
          api_key: "secret",
        }),
      ),
    ).toThrow(/must not be included/);

    const duplicate = `${buildLink({ name: "Example AI", provider: "custom", endpoint: "https://api.example.com/v1", model: "example-model" })}&model=other-model`;
    expect(() => parseAiConfigDeepLink(duplicate)).toThrow(/Duplicate parameter/);

    expect(() => parseAiConfigDeepLink("dbx://secret@settings/ai/new?name=Example&provider=custom&endpoint=https%3A%2F%2Fapi.example.com%2Fv1&model=example#token")).toThrow(/must not be included/);
  });

  it("rejects unsafe or incompatible endpoints and API styles", () => {
    expect(() =>
      parseAiConfigDeepLink(
        buildLink({
          name: "Example AI",
          provider: "openai-compatible",
          endpoint: "file:///tmp/api",
          model: "example-model",
        }),
      ),
    ).toThrow(/HTTP or HTTPS/);

    expect(() =>
      parseAiConfigDeepLink(
        buildLink({
          name: "Example AI",
          provider: "openai-compatible",
          endpoint: "https://user:password@api.example.com/v1",
          model: "example-model",
        }),
      ),
    ).toThrow(/must not include credentials/);

    expect(() =>
      parseAiConfigDeepLink(
        buildLink({
          name: "Example AI",
          provider: "anthropic-compatible",
          endpoint: "https://api.example.com/v1/messages",
          model: "example-model",
          api: "responses",
        }),
      ),
    ).toThrow(/require the messages API/);
  });
});

describe("clipboard API key candidates", () => {
  it("accepts a trimmed single-line value", () => {
    expect(clipboardApiKeyCandidate("  example-secret  ")).toBe("example-secret");
  });

  it("rejects empty, multiline, and oversized values", () => {
    expect(clipboardApiKeyCandidate("  ")).toBeNull();
    expect(clipboardApiKeyCandidate("first\nsecond")).toBeNull();
    expect(clipboardApiKeyCandidate("x".repeat(4097))).toBeNull();
  });

  it("does not read the clipboard until the user confirms", async () => {
    const readClipboard = vi.fn(async () => "example-secret");

    await expect(importClipboardApiKeyAfterConfirmation(async () => false, readClipboard)).resolves.toEqual({ kind: "declined" });
    expect(readClipboard).not.toHaveBeenCalled();

    await expect(importClipboardApiKeyAfterConfirmation(async () => true, readClipboard)).resolves.toEqual({ kind: "accepted", apiKey: "example-secret" });
    expect(readClipboard).toHaveBeenCalledTimes(1);
  });
});
