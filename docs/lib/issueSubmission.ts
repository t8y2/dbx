export const ISSUE_RATE_LIMIT = 8;
export const ISSUE_RATE_WINDOW_MS = 60 * 60 * 1000;
export const ISSUE_DRAFT_TTL_MS = 30 * 60 * 1000;
export const ISSUE_CLAIM_TTL_MS = 2 * 60 * 1000;
export const ISSUE_AI_TEXT_TIMEOUT_MS = 45_000;
export const ISSUE_AI_IMAGE_TIMEOUT_MS = 90_000;
export const MAX_ISSUE_IMAGES = 3;
export const MAX_ISSUE_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_ISSUE_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;
export const MAX_ISSUE_DESCRIPTION_LENGTH = 6000;
export const MAX_ISSUE_TITLE_LENGTH = 160;
export const MAX_ISSUE_BODY_LENGTH = 12000;

export const ISSUE_TYPES = ["bug", "feature", "question", "compatibility"] as const;

export type IssueType = (typeof ISSUE_TYPES)[number];
export type IssueLanguage = "cn" | "en";

export type IssuePreview = {
  type: IssueType;
  title: string;
  summary: string;
  body: string;
};

export type IssueImage = {
  bytes: Uint8Array;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  extension: "png" | "jpg" | "webp";
};

export type IssueAiConfig = {
  apiBase?: string;
  apiKey?: string;
  model?: string;
};

export type GitHubIssueConfig = {
  appId?: string;
  privateKey?: string;
  privateKeyBase64?: string;
  repository?: string;
};

export type RollingLimitResult = {
  allowed: boolean;
  timestamps: number[];
  remaining: number;
  resetAt: number;
};

export class IssueSubmissionError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(code);
    this.name = "IssueSubmissionError";
  }
}

const ISSUE_TYPE_META: Record<IssueType, { prefix: string; labels: string[] }> = {
  bug: { prefix: "[Bug]", labels: ["bug"] },
  feature: { prefix: "[Feature]", labels: ["enhancement"] },
  question: { prefix: "[Question]", labels: ["question"] },
  compatibility: { prefix: "[Compatibility]", labels: ["bug"] },
};

function cleanText(value: string): string {
  return value.replaceAll("\u0000", "").replace(/\r\n?/g, "\n").trim();
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(arrays.reduce((total, array) => total + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, "");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function encodeAsn1Length(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function encodeAsn1(tag: number, content: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag), encodeAsn1Length(content.length), content);
}

function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  return encodeAsn1(0x30, concatBytes(version, rsaAlgorithm, encodeAsn1(0x04, pkcs1)));
}

function parsePem(value: string): { label: string; bytes: Uint8Array } | null {
  const match = value.match(/-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/);
  if (!match) return null;
  return { label: match[1], bytes: base64Decode(match[2]) };
}

function loadGitHubPrivateKey(config: GitHubIssueConfig): Uint8Array {
  const rawKey = cleanText(config.privateKey?.replaceAll("\\n", "\n") ?? "");
  if (rawKey) {
    const pem = parsePem(rawKey);
    if (!pem) throw new IssueSubmissionError("GITHUB_APP_KEY_INVALID", 503);
    return pem.label === "RSA PRIVATE KEY" ? wrapPkcs1AsPkcs8(pem.bytes) : pem.bytes;
  }

  const encoded = cleanText(config.privateKeyBase64 ?? "");
  if (!encoded) throw new IssueSubmissionError("GITHUB_APP_NOT_CONFIGURED", 503);
  const decoded = base64Decode(encoded);
  const decodedText = new TextDecoder().decode(decoded);
  const pem = parsePem(decodedText);
  if (!pem) return decoded;
  return pem.label === "RSA PRIVATE KEY" ? wrapPkcs1AsPkcs8(pem.bytes) : pem.bytes;
}

export function normalizeIssueLanguage(value: FormDataEntryValue | null): IssueLanguage {
  return value === "en" ? "en" : "cn";
}

export function normalizeIssueType(value: unknown): IssueType {
  return typeof value === "string" && ISSUE_TYPES.includes(value as IssueType) ? (value as IssueType) : "bug";
}

export function validateIssueDescription(value: FormDataEntryValue | null): string {
  if (typeof value !== "string") throw new IssueSubmissionError("DESCRIPTION_REQUIRED");
  const description = cleanText(value);
  if (description.length < 4) throw new IssueSubmissionError("DESCRIPTION_TOO_SHORT");
  if (description.length > MAX_ISSUE_DESCRIPTION_LENGTH) throw new IssueSubmissionError("DESCRIPTION_TOO_LONG");
  return description;
}

export function validateEditableIssue(value: { type: unknown; title: unknown; body: unknown }): { type: IssueType; title: string; body: string; labels: string[] } {
  const type = normalizeIssueType(value.type);
  if (typeof value.title !== "string" || typeof value.body !== "string") throw new IssueSubmissionError("PREVIEW_INVALID");
  const title = normalizeIssueTitle(value.title, type);
  const body = cleanText(value.body);
  if (title.length < 8) throw new IssueSubmissionError("TITLE_TOO_SHORT");
  if (title.length > MAX_ISSUE_TITLE_LENGTH) throw new IssueSubmissionError("TITLE_TOO_LONG");
  if (body.length < 20) throw new IssueSubmissionError("BODY_TOO_SHORT");
  if (body.length > MAX_ISSUE_BODY_LENGTH) throw new IssueSubmissionError("BODY_TOO_LONG");
  return { type, title, body, labels: ISSUE_TYPE_META[type].labels };
}

export function normalizeIssueTitle(value: string, type: IssueType): string {
  let title = cleanText(value).replace(/\s*\n\s*/g, " ");
  for (const meta of Object.values(ISSUE_TYPE_META)) {
    if (title.toLowerCase().startsWith(meta.prefix.toLowerCase())) {
      title = title.slice(meta.prefix.length).trim();
      break;
    }
  }
  const prefix = ISSUE_TYPE_META[type].prefix;
  const allowedLength = MAX_ISSUE_TITLE_LENGTH - prefix.length - 1;
  return `${prefix} ${title.slice(0, allowedLength).trim()}`;
}

export function consumeRollingLimit(
  timestamps: number[],
  now: number,
  limit = ISSUE_RATE_LIMIT,
  windowMs = ISSUE_RATE_WINDOW_MS,
): RollingLimitResult {
  const active = timestamps.filter((timestamp) => Number.isFinite(timestamp) && timestamp > now - windowMs).sort((left, right) => left - right);
  if (active.length >= limit) {
    return { allowed: false, timestamps: active, remaining: 0, resetAt: active[0] + windowMs };
  }
  active.push(now);
  return { allowed: true, timestamps: active, remaining: Math.max(0, limit - active.length), resetAt: active[0] + windowMs };
}

export function detectIssueImageType(bytes: Uint8Array): Pick<IssueImage, "contentType" | "extension"> | null {
  if (bytes.length >= 8 && bytes.slice(0, 8).every((byte, index) => byte === Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)[index])) {
    return { contentType: "image/png", extension: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") {
    return { contentType: "image/webp", extension: "webp" };
  }
  return null;
}

export async function readIssueImages(entries: FormDataEntryValue[]): Promise<IssueImage[]> {
  const files = entries.filter((entry): entry is File => typeof entry !== "string" && entry.size > 0);
  if (files.length > MAX_ISSUE_IMAGES) throw new IssueSubmissionError("TOO_MANY_IMAGES");
  const images: IssueImage[] = [];
  let totalBytes = 0;

  for (const file of files) {
    if (file.size > MAX_ISSUE_IMAGE_BYTES) throw new IssueSubmissionError("IMAGE_TOO_LARGE");
    totalBytes += file.size;
    if (totalBytes > MAX_ISSUE_IMAGE_TOTAL_BYTES) throw new IssueSubmissionError("IMAGES_TOO_LARGE");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const detected = detectIssueImageType(bytes);
    if (!detected) throw new IssueSubmissionError("IMAGE_TYPE_UNSUPPORTED");
    images.push({ bytes, ...detected });
  }

  return images;
}

function issueAiEndpoint(apiBase: string): string {
  const normalized = apiBase.replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

export function issueAiRequestTimeoutMs(imageCount: number): number {
  return imageCount > 0 ? ISSUE_AI_IMAGE_TIMEOUT_MS : ISSUE_AI_TEXT_TIMEOUT_MS;
}

function issuePrompt(language: IssueLanguage): string {
  if (language === "en") {
    return [
      "You turn a short DBX user report and optional screenshots into a GitHub Issue draft.",
      "Return one JSON object only, without a Markdown fence.",
      'Schema: {"type":"bug|feature|question|compatibility","title":"...","summary":"...","body":"..."}.',
      "The body must be editable Markdown with useful section headings.",
      "Preserve facts from the report and screenshots. Never invent versions, logs, reproduction steps, expected behavior, or database details.",
      "Mark missing but important information as Not provided. Remove credentials or tokens if visible.",
      "Do not put the [Bug], [Feature], [Question], or [Compatibility] prefix in title.",
    ].join("\n");
  }
  return [
    "你负责把 DBX 用户的简短描述和可选截图整理成 GitHub Issue 草稿。",
    "只返回一个 JSON 对象，不要使用 Markdown 代码块。",
    '结构：{"type":"bug|feature|question|compatibility","title":"...","summary":"...","body":"..."}。',
    "body 使用可编辑的 Markdown 和清晰的小标题。",
    "只能保留描述或截图里能确认的事实，不得编造版本、日志、复现步骤、期望行为或数据库信息。",
    "重要信息缺失时明确写“未提供”。如果截图里出现密码、Token 或连接串，必须脱敏。",
    "title 不要包含 [Bug]、[Feature]、[Question] 或 [Compatibility] 前缀。",
  ].join("\n");
}

function extractAiContent(data: unknown): string {
  if (!data || typeof data !== "object") throw new IssueSubmissionError("AI_RESPONSE_INVALID", 502);
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") throw new IssueSubmissionError("AI_RESPONSE_INVALID", 502);
  const content = (choices[0] as { message?: { content?: unknown } }).message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("\n");
  }
  throw new IssueSubmissionError("AI_RESPONSE_INVALID", 502);
}

export function parseIssueAiResponse(content: string): IssuePreview {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new IssueSubmissionError("AI_RESPONSE_INVALID", 502);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new IssueSubmissionError("AI_RESPONSE_INVALID", 502);
  }

  if (!parsed || typeof parsed !== "object") throw new IssueSubmissionError("AI_RESPONSE_INVALID", 502);
  const value = parsed as Record<string, unknown>;
  const type = normalizeIssueType(value.type);
  if (typeof value.title !== "string" || typeof value.summary !== "string" || typeof value.body !== "string") {
    throw new IssueSubmissionError("AI_RESPONSE_INVALID", 502);
  }
  const title = normalizeIssueTitle(value.title, type);
  const summary = cleanText(value.summary).slice(0, 400);
  const body = cleanText(value.body);
  validateEditableIssue({ type, title, body });
  if (!summary) throw new IssueSubmissionError("AI_RESPONSE_INVALID", 502);
  return { type, title, summary, body };
}

export async function createIssuePreview(
  config: IssueAiConfig,
  description: string,
  images: IssueImage[],
  language: IssueLanguage,
): Promise<IssuePreview> {
  const apiBase = cleanText(config.apiBase ?? "");
  const apiKey = cleanText(config.apiKey ?? "");
  const model = cleanText(config.model ?? "");
  if (!apiBase || !apiKey || !model) throw new IssueSubmissionError("AI_NOT_CONFIGURED", 503);

  const userContent: Array<Record<string, unknown>> = [{ type: "text", text: description }];
  for (const image of images) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${image.contentType};base64,${base64Encode(image.bytes)}`, detail: "auto" },
    });
  }

  let response: Response;
  try {
    response = await fetch(issueAiEndpoint(apiBase), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 1800,
        messages: [
          { role: "system", content: issuePrompt(language) },
          { role: "user", content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(issueAiRequestTimeoutMs(images.length)),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new IssueSubmissionError("AI_REQUEST_TIMEOUT", 504);
    }
    throw new IssueSubmissionError("AI_REQUEST_FAILED", 502);
  }

  if (!response.ok) throw new IssueSubmissionError("AI_REQUEST_FAILED", 502);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new IssueSubmissionError("AI_RESPONSE_INVALID", 502);
  }
  return parseIssueAiResponse(extractAiContent(data));
}

async function createGitHubAppJwt(config: GitHubIssueConfig): Promise<string> {
  const appId = cleanText(config.appId ?? "");
  if (!appId) throw new IssueSubmissionError("GITHUB_APP_NOT_CONFIGURED", 503);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    asArrayBuffer(loadGitHubPrivateKey(config)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })));
  const unsignedToken = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(unsignedToken));
  return `${unsignedToken}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function githubJson(url: string, init: RequestInit): Promise<{ response: Response; data: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new IssueSubmissionError("GITHUB_REQUEST_FAILED", 502);
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { response, data };
}

async function getGitHubInstallationToken(config: GitHubIssueConfig): Promise<{ token: string; repository: string }> {
  const repository = cleanText(config.repository ?? "t8y2/dbx");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new IssueSubmissionError("GITHUB_REPOSITORY_INVALID", 503);
  const appJwt = await createGitHubAppJwt(config);
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${appJwt}`,
    "User-Agent": "dbx-issue-form",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const installation = await githubJson(`https://api.github.com/repos/${repository}/installation`, { headers });
  const installationId = installation.data && typeof installation.data === "object" ? (installation.data as { id?: unknown }).id : null;
  if (!installation.response.ok || (typeof installationId !== "number" && typeof installationId !== "string")) {
    throw new IssueSubmissionError("GITHUB_APP_INSTALLATION_NOT_FOUND", 502);
  }
  const repoName = repository.split("/")[1];
  const tokenResult = await githubJson(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ repositories: [repoName], permissions: { issues: "write" } }),
  });
  const token = tokenResult.data && typeof tokenResult.data === "object" ? (tokenResult.data as { token?: unknown }).token : null;
  if (!tokenResult.response.ok || typeof token !== "string" || !token) throw new IssueSubmissionError("GITHUB_TOKEN_FAILED", 502);
  return { token, repository };
}

export async function createPublicGitHubIssue(
  config: GitHubIssueConfig,
  issue: { title: string; body: string; labels: string[] },
): Promise<{ number: number; url: string }> {
  const { token, repository } = await getGitHubInstallationToken(config);
  const result = await githubJson(`https://api.github.com/repos/${repository}/issues`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "dbx-issue-form",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(issue),
  });
  const data = result.data && typeof result.data === "object" ? (result.data as { number?: unknown; html_url?: unknown }) : {};
  if (!result.response.ok || typeof data.number !== "number" || typeof data.html_url !== "string") {
    throw new IssueSubmissionError("GITHUB_ISSUE_CREATE_FAILED", 502);
  }
  return { number: data.number, url: data.html_url };
}

export function buildGitHubIssueBody(body: string, imageUrls: string[], language: IssueLanguage): string {
  const sections = [cleanText(body)];
  if (imageUrls.length > 0) {
    const heading = language === "cn" ? "## 附件" : "## Attachments";
    const images = imageUrls.map((url, index) => `![DBX issue image ${index + 1}](${url})`).join("\n\n");
    sections.push(`${heading}\n\n${images}`);
  }
  const source = language === "cn"
    ? "此 Issue 通过 DBX 官网匿名反馈入口提交，发布前已由提交者确认。"
    : "This Issue was submitted through the anonymous DBX website form and confirmed before publication.";
  sections.push(`---\n\n_${source}_`);
  return sections.join("\n\n");
}

export function issueImageObjectKey(draftId: string, extension: IssueImage["extension"], index: number, now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `issue-feedback/${year}/${month}/${draftId}/${index + 1}-${crypto.randomUUID()}.${extension}`;
}
