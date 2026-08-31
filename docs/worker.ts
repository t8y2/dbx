import {
  ISSUE_CLAIM_TTL_MS,
  ISSUE_DRAFT_TTL_MS,
  ISSUE_RATE_WINDOW_MS,
  IssueSubmissionError,
  buildGitHubIssueBody,
  consumeRollingLimit,
  createIssuePreview,
  createPublicGitHubIssue,
  issueImageObjectKey,
  normalizeIssueLanguage,
  readIssueImages,
  validateEditableIssue,
  validateIssueDescription,
  type IssueLanguage,
} from "./lib/issueSubmission";

type AssetsBinding = { fetch(request: Request): Promise<Response> };
type R2BucketBinding = {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
};
type DurableObjectStubBinding = { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
type DurableObjectNamespaceBinding = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubBinding;
};
type DurableObjectTransactionBinding = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
};
type DurableObjectStorageBinding = DurableObjectTransactionBinding & {
  transaction<T>(closure: (transaction: DurableObjectTransactionBinding) => Promise<T>): Promise<T>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAll(): Promise<void>;
};
type DurableObjectStateBinding = { storage: DurableObjectStorageBinding };

type Env = {
  ASSETS: AssetsBinding;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_OAUTH_CALLBACK_URL?: string;
  SESSION_SECRET?: string;
  ISSUE_AI_API_BASE?: string;
  ISSUE_AI_API_KEY?: string;
  ISSUE_AI_MODEL?: string;
  ISSUE_RATE_LIMIT_SECRET?: string;
  ISSUE_LIMITER?: DurableObjectNamespaceBinding;
  ISSUE_IMAGES?: R2BucketBinding;
  ISSUE_IMAGE_PUBLIC_BASE_URL?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_PRIVATE_KEY_B64?: string;
  ISSUE_GITHUB_REPOSITORY?: string;
};

type OAuthState = {
  state: string;
  verifier: string;
  returnTo: string;
  expiresAt: number;
};

type SessionUser = {
  login: string;
  avatarUrl: string;
  profileUrl: string;
  expiresAt: number;
};

type IssueSession = {
  id: string;
  expiresAt: number;
};

type IssueDraftRecord = {
  id: string;
  imageCount: number;
  language: IssueLanguage;
  createdAt: number;
  expiresAt: number;
  status: "ready" | "submitting" | "submitted";
  claimExpiresAt?: number;
  issueNumber?: number;
  issueUrl?: string;
};

type DurableClaimResult =
  | { state: "claimed"; draft: IssueDraftRecord }
  | { state: "completed"; issueNumber: number; issueUrl: string }
  | { state: "missing" }
  | { state: "expired" }
  | { state: "busy" };

const encoder = new TextEncoder();
const STATE_COOKIE = "dbx_oauth_state";
const SESSION_COOKIE = "dbx_contributor_session";
const ISSUE_SESSION_COOKIE = "dbx_issue_session";
const ISSUE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const IMAGE_ASSET_CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";

export function staticAssetCacheControl(pathname: string): string | null {
  if (pathname.startsWith("/_next/static/")) return IMMUTABLE_ASSET_CACHE_CONTROL;
  if (/\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i.test(pathname)) return IMAGE_ASSET_CACHE_CONTROL;
  return null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signPayload(payload: object, secret: string): Promise<string> {
  const encodedPayload = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(encodedPayload));
  return `${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifySignedPayload<T>(value: string | undefined, secret: string): Promise<T | null> {
  if (!value) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;

  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), asArrayBuffer(base64UrlDecode(signature)), encoder.encode(payload));
  if (!valid) return null;

  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as T;
  } catch {
    return null;
  }
}

export function sanitizeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/en/contributors";
  return value;
}

function parseCookies(request: Request): Record<string, string> {
  return Object.fromEntries(
    (request.headers.get("Cookie") ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return separator < 0 ? [part, ""] : [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      }),
  );
}

function cookie(name: string, value: string, maxAge: number, path = "/"): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
}

function randomToken(size = 32): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function codeChallenge(verifier: string): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  return Response.json(data, { status, headers: responseHeaders });
}

function requiredConfig(env: Env): { clientId: string; clientSecret: string; sessionSecret: string } | null {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.SESSION_SECRET) return null;
  return { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, sessionSecret: env.SESSION_SECRET };
}

async function startOAuth(request: Request, env: Env): Promise<Response> {
  const config = requiredConfig(env);
  if (!config) return json({ error: "GitHub OAuth is not configured" }, 503);

  const url = new URL(request.url);
  const state = randomToken();
  const verifier = randomToken(48);
  const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"));
  const callbackUrl = env.GITHUB_OAUTH_CALLBACK_URL || `${url.origin}/api/auth/github/callback`;
  const stateCookie = await signPayload({ state, verifier, returnTo, expiresAt: Date.now() + 10 * 60 * 1000 } satisfies OAuthState, config.sessionSecret);
  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", await codeChallenge(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl.toString(),
      "Set-Cookie": cookie(STATE_COOKIE, stateCookie, 10 * 60, "/api/auth/github"),
      "Cache-Control": "no-store",
    },
  });
}

async function finishOAuth(request: Request, env: Env): Promise<Response> {
  const config = requiredConfig(env);
  if (!config) return json({ error: "GitHub OAuth is not configured" }, 503);

  const url = new URL(request.url);
  const storedState = await verifySignedPayload<OAuthState>(parseCookies(request)[STATE_COOKIE], config.sessionSecret);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!storedState || storedState.expiresAt < Date.now() || !code || state !== storedState.state) return json({ error: "Invalid or expired OAuth state" }, 400);

  const callbackUrl = env.GITHUB_OAUTH_CALLBACK_URL || `${url.origin}/api/auth/github/callback`;
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "dbx-contributors" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: callbackUrl, code_verifier: storedState.verifier }),
  });
  const tokenData = (await tokenResponse.json()) as { access_token?: string; error?: string };
  if (!tokenResponse.ok || !tokenData.access_token) return json({ error: tokenData.error || "GitHub token exchange failed" }, 502);

  const userResponse = await fetch("https://api.github.com/user", {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "dbx-contributors", "X-GitHub-Api-Version": "2022-11-28" },
  });
  const githubUser = (await userResponse.json()) as { login?: string; avatar_url?: string; html_url?: string };
  if (!userResponse.ok || !githubUser.login) return json({ error: "Unable to read GitHub identity" }, 502);

  // The access token is intentionally discarded after reading the public identity.
  const session = await signPayload(
    {
      login: githubUser.login,
      avatarUrl: githubUser.avatar_url || `https://github.com/${githubUser.login}.png`,
      profileUrl: githubUser.html_url || `https://github.com/${githubUser.login}`,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    } satisfies SessionUser,
    config.sessionSecret,
  );

  const headers = new Headers({ Location: storedState.returnTo, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", cookie(STATE_COOKIE, "", 0, "/api/auth/github"));
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, session, 7 * 24 * 60 * 60));
  return new Response(null, { status: 302, headers });
}

async function currentUser(request: Request, env: Env): Promise<Response> {
  const config = requiredConfig(env);
  if (!config) return json({ authenticated: false, configured: false });

  const session = await verifySignedPayload<SessionUser>(parseCookies(request)[SESSION_COOKIE], config.sessionSecret);
  if (!session || session.expiresAt < Date.now()) return json({ authenticated: false, configured: true });
  return json({ authenticated: true, configured: true, user: { login: session.login, avatarUrl: session.avatarUrl, profileUrl: session.profileUrl } });
}

function logout(): Response {
  return json({ authenticated: false }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
}

async function contributorAvatar(request: Request): Promise<Response> {
  const login = new URL(request.url).searchParams.get("login") ?? "";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return json({ error: "Invalid GitHub login" }, 400);

  const response = await fetch(`https://github.com/${login}.png?size=256`, { redirect: "follow" });
  if (!response.ok || !response.body) return json({ error: "Avatar unavailable" }, 404);

  return new Response(response.body, {
    headers: {
      "Content-Type": response.headers.get("Content-Type") || "image/png",
      "Cache-Control": "public, max-age=86400, s-maxage=604800",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}

function issueSessionCookie(value: string, maxAge: number): string {
  return `${ISSUE_SESSION_COOKIE}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function issueRuntimeSecret(env: Env): string {
  const secret = env.ISSUE_RATE_LIMIT_SECRET || env.SESSION_SECRET;
  if (!secret) throw new IssueSubmissionError("ISSUE_RATE_LIMIT_NOT_CONFIGURED", 503);
  return secret;
}

async function issueIdentityHash(kind: "ip" | "session", value: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(`${kind}:${value}`));
  return base64UrlEncode(new Uint8Array(signature));
}

function durableStub(env: Env, name: string): DurableObjectStubBinding {
  if (!env.ISSUE_LIMITER) throw new IssueSubmissionError("ISSUE_LIMITER_NOT_CONFIGURED", 503);
  return env.ISSUE_LIMITER.get(env.ISSUE_LIMITER.idFromName(name));
}

async function durableJson<T>(stub: DurableObjectStubBinding, path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await stub.fetch(`https://issue-internal${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new IssueSubmissionError("ISSUE_STATE_UNAVAILABLE", 503);
  }
  if (!response.ok) throw new IssueSubmissionError("ISSUE_STATE_UNAVAILABLE", 503);
  try {
    return (await response.json()) as T;
  } catch {
    throw new IssueSubmissionError("ISSUE_STATE_UNAVAILABLE", 503);
  }
}

async function issueSession(request: Request, env: Env, create: boolean): Promise<{ session: IssueSession; setCookie?: string }> {
  const secret = issueRuntimeSecret(env);
  const existing = await verifySignedPayload<IssueSession>(parseCookies(request)[ISSUE_SESSION_COOKIE], secret);
  if (existing && existing.expiresAt > Date.now() && /^[A-Za-z0-9_-]{24,}$/.test(existing.id)) return { session: existing };
  if (!create) throw new IssueSubmissionError("ISSUE_SESSION_EXPIRED", 400);
  const session = { id: randomToken(24), expiresAt: Date.now() + ISSUE_SESSION_TTL_MS } satisfies IssueSession;
  const signed = await signPayload(session, secret);
  return { session, setCookie: issueSessionCookie(signed, Math.floor(ISSUE_SESSION_TTL_MS / 1000)) };
}

function requestIp(request: Request): string {
  const cloudflareIp = request.headers.get("CF-Connecting-IP")?.trim();
  if (cloudflareIp) return cloudflareIp;
  const hostname = new URL(request.url).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return "local-development";
  throw new IssueSubmissionError("IP_ADDRESS_UNAVAILABLE", 400);
}

function verifyIssueOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) throw new IssueSubmissionError("ORIGIN_NOT_ALLOWED", 403);
}

function issueError(error: unknown, headers?: HeadersInit): Response {
  if (error instanceof IssueSubmissionError) return json({ error: error.code }, error.status, headers);
  return json({ error: "ISSUE_REQUEST_FAILED" }, 500, headers);
}

function countIssueImageEntries(entries: FormDataEntryValue[]): number {
  return entries.filter((entry) => typeof entry !== "string" && entry.size > 0).length;
}

function publicImageUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function uploadIssueImages(env: Env, draftId: string, images: Awaited<ReturnType<typeof readIssueImages>>): Promise<{ keys: string[]; urls: string[] }> {
  if (images.length === 0) return { keys: [], urls: [] };
  if (!env.ISSUE_IMAGES) throw new IssueSubmissionError("ISSUE_IMAGE_STORAGE_NOT_CONFIGURED", 503);
  const baseUrl = env.ISSUE_IMAGE_PUBLIC_BASE_URL || "https://dl.dbxio.com";
  const keys: string[] = [];
  const urls: string[] = [];
  for (const [index, image] of images.entries()) {
    const key = issueImageObjectKey(draftId, image.extension, index);
    try {
      await env.ISSUE_IMAGES.put(key, image.bytes, {
        httpMetadata: { contentType: image.contentType, cacheControl: "public, max-age=31536000, immutable" },
      });
    } catch {
      await Promise.all(keys.map((uploadedKey) => env.ISSUE_IMAGES!.delete(uploadedKey).catch(() => undefined)));
      throw new IssueSubmissionError("ISSUE_IMAGE_UPLOAD_FAILED", 502);
    }
    keys.push(key);
    urls.push(publicImageUrl(baseUrl, key));
  }
  return { keys, urls };
}

async function deleteIssueImages(env: Env, keys: string[]): Promise<void> {
  if (!env.ISSUE_IMAGES) return;
  await Promise.all(keys.map((key) => env.ISSUE_IMAGES!.delete(key).catch(() => undefined)));
}

async function handleIssueDraft(request: Request, env: Env): Promise<Response> {
  let responseHeaders: HeadersInit | undefined;
  try {
    verifyIssueOrigin(request);
    const sessionResult = await issueSession(request, env, true);
    responseHeaders = sessionResult.setCookie ? { "Set-Cookie": sessionResult.setCookie } : undefined;
    const secret = issueRuntimeSecret(env);
    const ipHash = await issueIdentityHash("ip", requestIp(request), secret);
    const sessionHash = await issueIdentityHash("session", sessionResult.session.id, secret);
    const ipStub = durableStub(env, `ip:${ipHash}`);
    const sessionStub = durableStub(env, `session:${sessionHash}`);
    const ipLimit = await durableJson<ReturnType<typeof consumeRollingLimit>>(ipStub, "/limit/consume", {});
    if (!ipLimit.allowed) {
      return json({ error: "RATE_LIMITED", retryAfter: Math.max(1, Math.ceil((ipLimit.resetAt - Date.now()) / 1000)) }, 429, responseHeaders);
    }
    const sessionLimit = await durableJson<ReturnType<typeof consumeRollingLimit>>(sessionStub, "/limit/consume", {});
    if (!sessionLimit.allowed) {
      return json({ error: "RATE_LIMITED", retryAfter: Math.max(1, Math.ceil((sessionLimit.resetAt - Date.now()) / 1000)) }, 429, responseHeaders);
    }

    const form = await request.formData();
    const description = validateIssueDescription(form.get("description"));
    const language = normalizeIssueLanguage(form.get("language"));
    const images = await readIssueImages(form.getAll("images"));
    const preview = await createIssuePreview(
      { apiBase: env.ISSUE_AI_API_BASE, apiKey: env.ISSUE_AI_API_KEY, model: env.ISSUE_AI_MODEL },
      description,
      images,
      language,
    );
    const draftId = crypto.randomUUID();
    const now = Date.now();
    await durableJson(sessionStub, "/draft/create", {
      draft: {
        id: draftId,
        imageCount: images.length,
        language,
        createdAt: now,
        expiresAt: now + ISSUE_DRAFT_TTL_MS,
        status: "ready",
      } satisfies IssueDraftRecord,
    });
    return json(
      {
        draftId,
        expiresAt: now + ISSUE_DRAFT_TTL_MS,
        preview,
        rateLimit: {
          remaining: Math.min(ipLimit.remaining, sessionLimit.remaining),
          resetAt: Math.max(ipLimit.resetAt, sessionLimit.resetAt),
        },
      },
      200,
      responseHeaders,
    );
  } catch (error) {
    return issueError(error, responseHeaders);
  }
}

async function handleIssueSubmit(request: Request, env: Env): Promise<Response> {
  let claimed = false;
  let draftId = "";
  let sessionStub: DurableObjectStubBinding | null = null;
  let imageKeys: string[] = [];

  try {
    verifyIssueOrigin(request);
    const sessionResult = await issueSession(request, env, false);
    const secret = issueRuntimeSecret(env);
    const sessionHash = await issueIdentityHash("session", sessionResult.session.id, secret);
    sessionStub = durableStub(env, `session:${sessionHash}`);
    const form = await request.formData();
    const draftValue = form.get("draftId");
    if (typeof draftValue !== "string" || !/^[0-9a-f-]{36}$/i.test(draftValue)) throw new IssueSubmissionError("DRAFT_INVALID");
    draftId = draftValue;
    const imageEntries = form.getAll("images");
    const claim = await durableJson<DurableClaimResult>(sessionStub, "/draft/claim", { draftId, now: Date.now() });
    if (claim.state === "completed") return json({ issueNumber: claim.issueNumber, issueUrl: claim.issueUrl, alreadySubmitted: true });
    if (claim.state === "missing" || claim.state === "expired") throw new IssueSubmissionError("DRAFT_EXPIRED", 410);
    if (claim.state === "busy") throw new IssueSubmissionError("DRAFT_SUBMITTING", 409);
    claimed = true;
    if (countIssueImageEntries(imageEntries) !== claim.draft.imageCount) throw new IssueSubmissionError("DRAFT_IMAGES_CHANGED");
    const editable = validateEditableIssue({ type: form.get("type"), title: form.get("title"), body: form.get("body") });
    const images = await readIssueImages(imageEntries);
    const uploaded = await uploadIssueImages(env, draftId, images);
    imageKeys = uploaded.keys;
    const issue = await createPublicGitHubIssue(
      {
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        privateKeyBase64: env.GITHUB_APP_PRIVATE_KEY_B64,
        repository: env.ISSUE_GITHUB_REPOSITORY,
      },
      {
        title: editable.title,
        body: buildGitHubIssueBody(editable.body, uploaded.urls, claim.draft.language),
        labels: editable.labels,
      },
    );
    claimed = false;
    try {
      await durableJson(sessionStub, "/draft/complete", { draftId, issueNumber: issue.number, issueUrl: issue.url, now: Date.now() });
    } catch {
      return json({ issueNumber: issue.number, issueUrl: issue.url });
    }
    return json({ issueNumber: issue.number, issueUrl: issue.url });
  } catch (error) {
    await deleteIssueImages(env, imageKeys);
    if (claimed && sessionStub && draftId) {
      try {
        await durableJson(sessionStub, "/draft/release", { draftId });
      } catch {
        return issueError(error);
      }
    }
    return issueError(error);
  }
}

function preferredIssueLanguage(request: Request): IssueLanguage {
  return request.headers.get("Accept-Language")?.trim().toLowerCase().startsWith("zh") ? "cn" : "en";
}

export function issueRedirectPath(pathname: string, language: IssueLanguage): string | null {
  if (pathname === "/issue" || pathname === "/issue/" || pathname === "/issues" || pathname === "/issues/") return `/${language}/issue`;
  const localized = pathname.match(/^\/(cn|en)\/issues\/?$/);
  return localized ? `/${localized[1]}/issue` : null;
}

export class IssueSubmissionLimiter {
  constructor(private readonly state: DurableObjectStateBinding) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

    if (url.pathname === "/limit/consume") {
      const now = Date.now();
      const result = await this.state.storage.transaction(async (transaction) => {
        const timestamps = (await transaction.get<number[]>("rate")) ?? [];
        const next = consumeRollingLimit(timestamps, now);
        if (next.allowed) await transaction.put("rate", next.timestamps);
        return next;
      });
      const lastTimestamp = result.timestamps.at(-1);
      if (lastTimestamp) await this.state.storage.setAlarm(lastTimestamp + ISSUE_RATE_WINDOW_MS + 1000);
      return json(result);
    }

    let payload: Record<string, unknown>;
    try {
      payload = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "INVALID_JSON" }, 400);
    }

    if (url.pathname === "/draft/create") {
      const draft = payload.draft as IssueDraftRecord | undefined;
      if (!draft || !/^[0-9a-f-]{36}$/i.test(draft.id)) return json({ error: "DRAFT_INVALID" }, 400);
      await this.state.storage.put(`draft:${draft.id}`, draft);
      return json({ created: true });
    }

    if (url.pathname === "/draft/claim") {
      const draftId = typeof payload.draftId === "string" ? payload.draftId : "";
      const now = typeof payload.now === "number" ? payload.now : Date.now();
      const result = await this.state.storage.transaction<DurableClaimResult>(async (transaction) => {
        const key = `draft:${draftId}`;
        const draft = await transaction.get<IssueDraftRecord>(key);
        if (!draft) return { state: "missing" };
        if (draft.status === "submitted" && draft.issueNumber && draft.issueUrl) {
          return { state: "completed", issueNumber: draft.issueNumber, issueUrl: draft.issueUrl };
        }
        if (draft.expiresAt <= now) {
          await transaction.delete(key);
          return { state: "expired" };
        }
        if (draft.status === "submitting" && (draft.claimExpiresAt ?? 0) > now) return { state: "busy" };
        const claimed = { ...draft, status: "submitting", claimExpiresAt: now + ISSUE_CLAIM_TTL_MS } satisfies IssueDraftRecord;
        await transaction.put(key, claimed);
        return { state: "claimed", draft: claimed };
      });
      return json(result);
    }

    if (url.pathname === "/draft/release") {
      const draftId = typeof payload.draftId === "string" ? payload.draftId : "";
      await this.state.storage.transaction(async (transaction) => {
        const key = `draft:${draftId}`;
        const draft = await transaction.get<IssueDraftRecord>(key);
        if (draft?.status === "submitting") await transaction.put(key, { ...draft, status: "ready", claimExpiresAt: undefined });
      });
      return json({ released: true });
    }

    if (url.pathname === "/draft/complete") {
      const draftId = typeof payload.draftId === "string" ? payload.draftId : "";
      const issueNumber = typeof payload.issueNumber === "number" ? payload.issueNumber : 0;
      const issueUrl = typeof payload.issueUrl === "string" ? payload.issueUrl : "";
      const now = typeof payload.now === "number" ? payload.now : Date.now();
      if (!issueNumber || !issueUrl) return json({ error: "ISSUE_RESULT_INVALID" }, 400);
      await this.state.storage.transaction(async (transaction) => {
        const key = `draft:${draftId}`;
        const draft = await transaction.get<IssueDraftRecord>(key);
        if (draft) {
          await transaction.put(key, {
            ...draft,
            status: "submitted",
            claimExpiresAt: undefined,
            issueNumber,
            issueUrl,
            expiresAt: now + ISSUE_RATE_WINDOW_MS,
          });
        }
      });
      return json({ completed: true });
    }

    return json({ error: "NOT_FOUND" }, 404);
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const issueRedirect = issueRedirectPath(url.pathname, preferredIssueLanguage(request));
    if (issueRedirect && request.method === "GET") return Response.redirect(`${url.origin}${issueRedirect}`, 308);
    if (url.pathname === "/api/issues/draft" && request.method === "POST") return handleIssueDraft(request, env);
    if (url.pathname === "/api/issues/submit" && request.method === "POST") return handleIssueSubmit(request, env);
    if (url.pathname === "/api/auth/github/start" && request.method === "GET") return startOAuth(request, env);
    if (url.pathname === "/api/auth/github/callback" && request.method === "GET") return finishOAuth(request, env);
    if (url.pathname === "/api/auth/me" && request.method === "GET") return currentUser(request, env);
    if (url.pathname === "/api/auth/logout" && request.method === "POST") return logout();
    if (url.pathname === "/api/contributor-avatar" && request.method === "GET") return contributorAvatar(request);
    const response = await env.ASSETS.fetch(request);
    const cacheControl = staticAssetCacheControl(url.pathname);
    if (!cacheControl || response.status < 200 || response.status >= 400) return response;

    const headers = new Headers(response.headers);
    headers.set("Cache-Control", cacheControl);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
