// Shared Cloudflare KV / OAuth plumbing for the ops scripts in this directory.
// Only used from a workstation: the token is the wrangler OAuth session (or
// CLOUDFLARE_API_TOKEN), never something a Worker holds.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const API = "https://api.cloudflare.com/client/v4";
export const BULK_GET_BATCH = 100;
const WRANGLER_CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";

function wranglerConfigPath() {
  if (process.env.WRANGLER_CONFIG) return process.env.WRANGLER_CONFIG;
  const candidates =
    process.platform === "win32"
      ? [path.join(process.env.APPDATA ?? os.homedir(), ".wrangler", "config", "default.toml")]
      : [
          path.join(os.homedir(), "Library", "Preferences", ".wrangler", "config", "default.toml"),
          path.join(os.homedir(), ".wrangler", "config", "default.toml"),
        ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function readTomlValue(text, field) {
  const match = text.match(new RegExp(`^${field} = "(.*)"$`, "m"));
  return match ? match[1] : null;
}

/** Wrangler OAuth: refresh the access token and persist the rotated refresh token. */
async function tokenFromWrangler() {
  const configPath = wranglerConfigPath();
  if (!configPath) throw new Error("no CLOUDFLARE_API_TOKEN and no wrangler config found; run `npx wrangler login`");
  const text = fs.readFileSync(configPath, "utf8");
  const refreshToken = readTomlValue(text, "refresh_token");
  if (!refreshToken) throw new Error(`${configPath} has no refresh_token; run \`npx wrangler login\``);

  const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: WRANGLER_CLIENT_ID }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    throw new Error(`wrangler token refresh failed (${response.status}): ${JSON.stringify(payload).slice(0, 300)}`);
  }
  const expires = new Date(Date.now() + (payload.expires_in ?? 3600) * 1000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
  const updated = text
    .replace(/^oauth_token = ".*"$/m, `oauth_token = "${payload.access_token}"`)
    .replace(/^refresh_token = ".*"$/m, `refresh_token = "${payload.refresh_token ?? refreshToken}"`)
    .replace(/^expiration_time = ".*"$/m, `expiration_time = "${expires}"`);
  fs.writeFileSync(configPath, updated, { mode: 0o600 });
  return payload.access_token;
}

export async function accessToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  return tokenFromWrangler();
}

export async function api(token, method, pathname, body, options = {}) {
  const response = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": options.raw ? "text/plain" : "application/json" }),
    },
    // KV values take the raw text as the body; everything else is JSON.
    body: body === undefined ? undefined : options.raw ? body : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(`${method} ${pathname} -> ${response.status}: ${JSON.stringify(payload.errors ?? payload).slice(0, 400)}`);
  }
  return payload;
}

/** KV `values/` responses are the raw value, not a JSON envelope. */
export async function apiText(token, pathname) {
  const response = await fetch(`${API}${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const error = new Error(`GET ${pathname} -> ${response.status}: ${(await response.text()).slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }
  return response.text();
}

export async function listKeys(token, account, namespace) {
  const keys = [];
  let cursor;
  for (;;) {
    const query = new URLSearchParams({ limit: "1000", ...(cursor ? { cursor } : {}) });
    const payload = await api(token, "GET", `/accounts/${account}/storage/kv/namespaces/${namespace}/keys?${query}`);
    keys.push(...payload.result.map((entry) => entry.name));
    cursor = payload.result_info?.cursor;
    if (!cursor || payload.result.length === 0) break;
  }
  return keys;
}

export async function bulkGet(token, account, namespace, keys) {
  const values = {};
  for (let index = 0; index < keys.length; index += BULK_GET_BATCH) {
    const batch = keys.slice(index, index + BULK_GET_BATCH);
    const payload = await api(token, "POST", `/accounts/${account}/storage/kv/namespaces/${namespace}/bulk/get`, { keys: batch, type: "text" });
    Object.assign(values, payload.result?.values ?? {});
    process.stdout.write(`\r  read ${Math.min(index + batch.length, keys.length)}/${keys.length} keys`);
  }
  process.stdout.write("\n");
  return values;
}

/** Paginated "every key in the namespace" helper shared by both ops scripts. */
export function chunk(array, size) {
  const out = [];
  for (let index = 0; index < array.length; index += size) out.push(array.slice(index, index + size));
  return out;
}
