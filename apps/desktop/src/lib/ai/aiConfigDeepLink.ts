import type { AiApiStyle, AiAuthMethod, AiProvider } from "@/types/ai";

const AI_CONFIG_DEEP_LINK_HOST = "settings";
const AI_CONFIG_DEEP_LINK_PATH = "/ai/new";
const MAX_DEEP_LINK_LENGTH = 4096;
const MAX_CONFIG_NAME_LENGTH = 120;
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_MODEL_LENGTH = 256;
const MAX_CLIPBOARD_API_KEY_LENGTH = 4096;

const SUPPORTED_PROVIDERS = new Set<AiProvider>(["openai-compatible", "anthropic-compatible", "custom"]);
const SUPPORTED_PARAMS = new Set(["v", "name", "provider", "endpoint", "model", "auth", "api", "clipboard"]);
const SENSITIVE_PARAMS = new Set(["api_key", "apikey", "authorization", "password", "secret", "token"]);

export interface AiConfigDeepLinkDraft {
  name: string;
  provider: AiProvider;
  endpoint: string;
  model: string;
  authMethod: AiAuthMethod;
  apiStyle: AiApiStyle;
  promptForClipboardApiKey: boolean;
}

export type ClipboardApiKeyImportResult = { kind: "declined" } | { kind: "empty" } | { kind: "invalid" } | { kind: "accepted"; apiKey: string };

function requiredParam(url: URL, name: string, maxLength: number): string {
  const value = url.searchParams.get(name)?.trim() ?? "";
  if (!value) throw new Error(`Missing ${name}`);
  if (value.length > maxLength) throw new Error(`${name} is too long`);
  return value;
}

function parseProvider(value: string): AiProvider {
  if (!SUPPORTED_PROVIDERS.has(value as AiProvider)) throw new Error("Unsupported AI provider");
  return value as AiProvider;
}

function defaultAuthMethod(provider: AiProvider, apiStyle: AiApiStyle): AiAuthMethod {
  return provider === "anthropic-compatible" || apiStyle === "anthropic-messages" ? "api-key" : "bearer";
}

function defaultApiStyle(provider: AiProvider): AiApiStyle {
  return provider === "anthropic-compatible" ? "anthropic-messages" : "completions";
}

function parseAuthMethod(value: string | null, provider: AiProvider, apiStyle: AiApiStyle): AiAuthMethod {
  if (!value) return defaultAuthMethod(provider, apiStyle);
  if (value !== "api-key" && value !== "bearer") throw new Error("Unsupported AI authentication method");
  return value;
}

function parseApiStyle(value: string | null, provider: AiProvider): AiApiStyle {
  const style = value || defaultApiStyle(provider);
  if (style !== "completions" && style !== "responses" && style !== "anthropic-messages") throw new Error("Unsupported AI API style");
  if (provider === "anthropic-compatible" && style !== "anthropic-messages") throw new Error("Anthropic-compatible providers require the messages API");
  if (provider === "openai-compatible" && style === "anthropic-messages") throw new Error("OpenAI-compatible providers do not support the Anthropic messages API");
  return style;
}

function parseEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Invalid AI endpoint");
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw new Error("AI endpoint must use HTTP or HTTPS");
  if (!endpoint.hostname) throw new Error("AI endpoint must include a host");
  if (endpoint.username || endpoint.password) throw new Error("AI endpoint must not include credentials");
  if (endpoint.hash) throw new Error("AI endpoint must not include a fragment");
  return value.replace(/\/+$/, "");
}

function validateParams(url: URL): void {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase();
    if (SENSITIVE_PARAMS.has(normalized)) throw new Error("API keys and other secrets must not be included in the link");
    if (!SUPPORTED_PARAMS.has(normalized) || key !== normalized) throw new Error(`Unsupported parameter: ${key}`);
    if (seen.has(normalized)) throw new Error(`Duplicate parameter: ${key}`);
    seen.add(normalized);
  }
}

export function parseAiConfigDeepLink(value: string): AiConfigDeepLinkDraft | null {
  const trimmed = value.trim();
  if (trimmed.length > MAX_DEEP_LINK_LENGTH) throw new Error("AI configuration link is too long");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "dbx:" || url.hostname !== AI_CONFIG_DEEP_LINK_HOST || url.pathname !== AI_CONFIG_DEEP_LINK_PATH) return null;
  if (url.username || url.password || url.hash) throw new Error("API keys and other secrets must not be included in the link");

  validateParams(url);
  const version = url.searchParams.get("v");
  if (version && version !== "1") throw new Error("Unsupported AI configuration link version");

  const provider = parseProvider(requiredParam(url, "provider", 64));
  const apiStyle = parseApiStyle(url.searchParams.get("api"), provider);
  const clipboard = url.searchParams.get("clipboard");
  if (clipboard && clipboard !== "prompt") throw new Error("Unsupported clipboard behavior");

  return {
    name: requiredParam(url, "name", MAX_CONFIG_NAME_LENGTH),
    provider,
    endpoint: parseEndpoint(requiredParam(url, "endpoint", MAX_ENDPOINT_LENGTH)),
    model: requiredParam(url, "model", MAX_MODEL_LENGTH),
    authMethod: parseAuthMethod(url.searchParams.get("auth"), provider, apiStyle),
    apiStyle,
    promptForClipboardApiKey: clipboard === "prompt",
  };
}

export function clipboardApiKeyCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CLIPBOARD_API_KEY_LENGTH || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

export async function importClipboardApiKeyAfterConfirmation(confirmRead: () => Promise<boolean>, readClipboard: () => Promise<string>): Promise<ClipboardApiKeyImportResult> {
  if (!(await confirmRead())) return { kind: "declined" };
  const clipboardText = await readClipboard();
  const apiKey = clipboardApiKeyCandidate(clipboardText);
  if (apiKey) return { kind: "accepted", apiKey };
  return clipboardText.trim() ? { kind: "invalid" } : { kind: "empty" };
}
