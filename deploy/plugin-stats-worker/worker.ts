// Counts plugin marketplace traffic on Cloudflare without touching artifact bytes.
//
// Routes (see wrangler.json):
// - dl.dbxio.com/plugins/*: counts each GET of a real `.dbxp` artifact (icons and
//   other static assets are excluded — they are fetched on every marketplace
//   page/app view and would both burn quota and pollute the numbers), then
//   passes the request through to the R2 custom domain. Same-zone subrequests do
//   not re-enter Workers, so the pass-through cannot loop.
// - dbxio.com/api/plugins/install: fire-and-forget beacon the desktop app can
//   send after a successful marketplace install. Decorative statistics only.
// - dbxio.com/api/plugins/archive: token-gated manual trigger for the daily
//   aggregation (same handler the cron runs), for verification and backfills.
//
// Storage:
// - Workers Analytics Engine (binding PLUGIN_STATS) — one datapoint per event.
//   AE only retains three months, so a daily cron aggregates the trailing
//   window into the `plugin_stats_archive` KV namespace, which holds the
//   permanent totals. KV is fine here: ~1 write per active key per day.

type AnalyticsEngineBinding = {
  writeDataPoint(event: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
};

type KvBinding = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

type Env = {
  PLUGIN_STATS: AnalyticsEngineBinding;
  PLUGIN_ARCHIVE: KvBinding;
  ANALYTICS_TOKEN: string;
  CF_ACCOUNT_ID: string;
  STATS_SALT: string;
};

const DOWNLOAD_PATTERN = /^\/plugins\/([A-Za-z0-9._-]{1,64})\/([0-9A-Za-z.+-]{1,32})\//;
const ARTIFACT_SUFFIX_PATTERN = /\.dbxp$/;
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/;
const INSTALL_BODY_LIMIT_BYTES = 512;
const COUNTED_KINDS = new Set(["dl", "inst"]);
const ARCHIVE_META_KEY = "meta:last-success";
const ARCHIVE_SUMMARY_KEY = "summary";
const ARCHIVE_TRIGGER_HEADER = "x-archive-token";
const SQL_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// Truncated HMAC of (salt, ip|utc-day): lets aggregations count distinct
// downloaders per group without storing IPs. Anti-inflation only — a
// determined attacker rotating IPs can still inflate; that is acceptable for
// decorative stats. Legacy events written before this field have no blob4 and
// are excluded from unique counts (raw counts keep covering them).
async function ipDayIdentity(env: Env, request: Request): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STATS_SALT), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ip}|${day}`));
  return [...new Uint8Array(mac)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function recordEvent(env: Env, kind: "dl" | "inst", pluginId: string, version: string, identity: string): Promise<void> {
  try {
    env.PLUGIN_STATS.writeDataPoint({
      // index on pluginId keeps per-plugin queries well-sharded
      indexes: [pluginId],
      blobs: [kind, pluginId, version, identity],
      doubles: [1],
    });
  } catch (error) {
    console.error(`plugin-stats writeDataPoint failed for ${kind}:${pluginId}:${version}`, error);
  }
}

function emptyResponse(status: number): Response {
  return new Response(null, { status, headers: CORS_HEADERS });
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

type WindowCount = { kind: string; plugin: string; version: string; events: number };

// The SQL API answers with ClickHouse-style {meta, data}; rows may arrive as
// objects or as arrays to zip against meta. Accept a plain record array too so
// a format drift degrades instead of breaking.
function parseSqlRows(payload: unknown): Array<Record<string, unknown>> {
  if (typeof payload !== "object" || payload === null) return [];
  const { meta, data, result } = payload as Record<string, unknown>;
  if (Array.isArray(data)) {
    const columns = Array.isArray(meta) ? (meta as Array<{ name?: string }>).map((entry) => entry?.name ?? "") : [];
    return (data as unknown[]).map((row) => {
      if (Array.isArray(row)) return Object.fromEntries(columns.map((column, index) => [column, row[index]]));
      if (typeof row === "object" && row !== null) return row as Record<string, unknown>;
      return {};
    });
  }
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
}

type DailyUnique = { kind: string; plugin: string; day: string; uniq: number };

async function fetchDailyUniques(env: Env, from: Date, to: Date): Promise<DailyUnique[]> {
  // The SQL dialect rejects function expressions in GROUP BY but accepts
  // aliases, so bucket per hour and merge into per-day sums in JS. Hourly
  // distincts slightly overestimate the daily distinct (an identity active
  // across an hour boundary counts once per bucket); acceptable for decorative
  // unique counts and immune to multi-version release inflation.
  const query =
    "SELECT blob1 AS kind, blob2 AS plugin, toStartOfHour(timestamp) AS hour, count(DISTINCT blob4) AS uniq " +
    `FROM DBX_PLUGIN_STATS WHERE timestamp > toDateTime(${sqlString(sqlTimestamp(from))}) ` +
    `AND timestamp <= toDateTime(${sqlString(sqlTimestamp(to))}) AND blob4 != '' ` +
    "GROUP BY kind, plugin, hour";
  const response = await fetch(`${SQL_ENDPOINT}/${env.CF_ACCOUNT_ID}/analytics_engine/sql?query=${encodeURIComponent(query)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${env.ANALYTICS_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`Analytics SQL API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const payload = (await response.json()) as unknown;
  const buckets = parseSqlRows(payload)
    .map((row) => ({
      kind: String(row.kind ?? ""),
      plugin: String(row.plugin ?? ""),
      day: String(row.hour ?? "").slice(0, 10),
      uniq: Number(row.uniq ?? 0) || 0,
    }))
    .filter((row) => COUNTED_KINDS.has(row.kind) && PLUGIN_ID_PATTERN.test(row.plugin));
  const byDay = new Map<string, number>();
  for (const bucket of buckets) {
    const key = `${bucket.kind}:${bucket.plugin}:${bucket.day}`;
    byDay.set(key, (byDay.get(key) ?? 0) + bucket.uniq);
  }
  return [...byDay].map(([key, uniq]) => {
    const [kind, plugin, day] = key.split(":");
    return { kind, plugin, day, uniq };
  });
}

async function fetchWindowCounts(env: Env, from: Date, to: Date): Promise<WindowCount[]> {
  // SQL reads the dataset by NAME (wrangler.json `dataset`), not by binding —
  // keep in sync with the analytics_engine_datasets entry.
  const query =
    "SELECT blob1 AS kind, blob2 AS plugin, blob3 AS version, SUM(_sample_interval) AS events " +
    `FROM DBX_PLUGIN_STATS WHERE timestamp > toDateTime(${sqlString(sqlTimestamp(from))}) ` +
    `AND timestamp <= toDateTime(${sqlString(sqlTimestamp(to))}) GROUP BY blob1, blob2, blob3`;
  // The SQL API takes the statement as a URL parameter, not a form body (a
  // form-encoded body is parsed as the raw SQL and rejected with a 422).
  const response = await fetch(`${SQL_ENDPOINT}/${env.CF_ACCOUNT_ID}/analytics_engine/sql?query=${encodeURIComponent(query)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${env.ANALYTICS_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`Analytics SQL API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const payload = (await response.json()) as unknown;
  return parseSqlRows(payload)
    .map((row) => ({
      kind: String(row.kind ?? ""),
      plugin: String(row.plugin ?? ""),
      version: String(row.version ?? ""),
      events: Number(row.events ?? 0) || 0,
    }))
    .filter((row) => COUNTED_KINDS.has(row.kind) && PLUGIN_ID_PATTERN.test(row.plugin) && VERSION_PATTERN.test(row.version));
}

// Aggregates events in (last-success, now] into permanent KV totals. The window
// marker is only advanced after every write lands, so a failed run retries the
// same window on the next cron; a crash mid-write can double-count a window,
// which is acceptable for decorative stats.
async function runAggregation(env: Env, fromOverride?: string): Promise<{ from: string; to: string; activeKeys: number }> {
  const to = new Date();
  // `x-archive-from: reset` re-aggregates from the epoch (backfill after a fix);
  // totals are additive, so only use it when the archived window is known-empty.
  const override = fromOverride?.trim().toLowerCase() === "reset" ? new Date(0) : undefined;
  const lastSuccess = await env.PLUGIN_ARCHIVE.get(ARCHIVE_META_KEY);
  const from = override ?? (lastSuccess ? new Date(`${lastSuccess.replace(" ", "T")}Z`) : new Date(0));
  if (Number.isNaN(from.getTime())) throw new Error(`Corrupted ${ARCHIVE_META_KEY}: ${lastSuccess}`);

  const [counts, uniques] = await Promise.all([fetchWindowCounts(env, from, to), fetchDailyUniques(env, from, to)]);
  const summary = JSON.parse((await env.PLUGIN_ARCHIVE.get(ARCHIVE_SUMMARY_KEY)) ?? "{}") as Record<string, Record<string, number>>;

  const pluginTotals = new Map<string, number>();
  for (const count of counts) {
    const totalKey = `total:${count.kind}:${count.plugin}:${count.version}`;
    const current = Number.parseInt((await env.PLUGIN_ARCHIVE.get(totalKey)) ?? "0", 10) || 0;
    await env.PLUGIN_ARCHIVE.put(totalKey, String(current + count.events));
    pluginTotals.set(`${count.kind}:${count.plugin}`, (pluginTotals.get(`${count.kind}:${count.plugin}`) ?? 0) + count.events);
    const byKind = (summary[count.kind] ??= {});
    byKind[count.plugin] = (byKind[count.plugin] ?? 0) + count.events;
  }
  for (const [pair, delta] of pluginTotals) {
    const [kind, plugin] = pair.split(":");
    const pluginKey = `total:${kind}:${plugin}`;
    const current = Number.parseInt((await env.PLUGIN_ARCHIVE.get(pluginKey)) ?? "0", 10) || 0;
    await env.PLUGIN_ARCHIVE.put(pluginKey, String(current + delta));
  }
  // Daily uniques overwrite (not add): reruns converge to the full-day value,
  // and multi-version releases cannot inflate the per-plugin downloader count.
  for (const unique of uniques) {
    await env.PLUGIN_ARCHIVE.put(`uniqd:${unique.kind}:${unique.plugin}:${unique.day}`, String(unique.uniq));
  }

  await env.PLUGIN_ARCHIVE.put(ARCHIVE_SUMMARY_KEY, JSON.stringify(summary));
  await env.PLUGIN_ARCHIVE.put(ARCHIVE_META_KEY, sqlTimestamp(to));
  return { from: sqlTimestamp(from), to: sqlTimestamp(to), activeKeys: counts.length, uniqueDays: uniques.length };
}

async function handleInstallBeacon(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return emptyResponse(204);

  const url = new URL(request.url);
  if (url.pathname === "/api/plugins/archive") {
    if (request.method !== "POST") return emptyResponse(405);
    if (request.headers.get(ARCHIVE_TRIGGER_HEADER) !== env.ANALYTICS_TOKEN) return emptyResponse(401);
    try {
      return Response.json(await runAggregation(env, request.headers.get("x-archive-from") ?? undefined), { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      console.error("plugin-stats aggregation failed", error);
      return Response.json({ error: String(error) }, { status: 500, headers: { "Cache-Control": "no-store" } });
    }
  }

  if (request.method !== "POST") return emptyResponse(405);
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > INSTALL_BODY_LIMIT_BYTES) return emptyResponse(413);

  let payload: unknown;
  try {
    payload = JSON.parse(await request.text()) as unknown;
  } catch {
    return emptyResponse(400);
  }
  const { id, version } = (payload ?? {}) as Record<string, unknown>;
  if (typeof id !== "string" || !PLUGIN_ID_PATTERN.test(id)) return emptyResponse(400);
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) return emptyResponse(400);

  await recordEvent(env, "inst", id, version, await ipDayIdentity(env, request));
  return emptyResponse(204);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "dl.dbxio.com") {
      if (request.method === "GET") {
        const download = url.pathname.match(DOWNLOAD_PATTERN);
        if (download && ARTIFACT_SUFFIX_PATTERN.test(url.pathname)) {
          await recordEvent(env, "dl", download[1], download[2], await ipDayIdentity(env, request));
        }
      }
      return fetch(request);
    }
    return handleInstallBeacon(request, env);
  },

  async scheduled(_controller: unknown, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(
      runAggregation(env).catch((error) => {
        console.error("plugin-stats scheduled aggregation failed", error);
      }),
    );
  },
};
