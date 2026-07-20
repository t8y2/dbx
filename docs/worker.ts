type AssetsBinding = { fetch(request: Request): Promise<Response> };

type Env = {
  ASSETS: AssetsBinding;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_OAUTH_CALLBACK_URL?: string;
  SESSION_SECRET?: string;
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

const encoder = new TextEncoder();
const STATE_COOKIE = "dbx_oauth_state";
const SESSION_COOKIE = "dbx_contributor_session";

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
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/github/start" && request.method === "GET") return startOAuth(request, env);
    if (url.pathname === "/api/auth/github/callback" && request.method === "GET") return finishOAuth(request, env);
    if (url.pathname === "/api/auth/me" && request.method === "GET") return currentUser(request, env);
    if (url.pathname === "/api/auth/logout" && request.method === "POST") return logout();
    if (url.pathname === "/api/contributor-avatar" && request.method === "GET") return contributorAvatar(request);
    return env.ASSETS.fetch(request);
  },
};
