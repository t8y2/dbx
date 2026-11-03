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
// - dbxio.com/api/plugins/stats: public read of the display counters (installs
//   per plugin) from the archive summary — consumed by the website cards.
// - dbxio.com/api/plugins/archive: token-gated manual trigger for the daily
//   aggregation (same handler the cron runs), for verification and backfills.
//
// Event kinds (blob1):
// - dl:   artifact download (server-side, per .dbxp GET)
// - inst: fresh install (beacon `kind:"install"`); legacy beacons without a
//         kind also land here — they keep feeding the historical mixed-event
//         base until the fleet upgrades, so the inst curve stays comparable
// - updt: version update (beacon `kind:"update"`)
//
// Identity (blob4, only used for per-day unique counts):
// - inst/updt events carry the app's anonymous random installation id when
//   available (stable across days → true per-machine uniques)
// - dl events and legacy beacons fall back to a day-scoped IP HMAC
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
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

type Env = {
  PLUGIN_STATS: AnalyticsEngineBinding;
  PLUGIN_ARCHIVE: KvBinding;
  ANALYTICS_TOKEN: string;
  CF_ACCOUNT_ID: string;
  STATS_SALT: string;
};

type EventKind = "dl" | "inst" | "updt";

const DOWNLOAD_PATTERN = /^\/plugins\/([A-Za-z0-9._-]{1,64})\/([0-9A-Za-z.+-]{1,32})\//;
const ARTIFACT_SUFFIX_PATTERN = /\.dbxp$/;
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/;
const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTALL_BODY_LIMIT_BYTES = 512;
const COUNTED_KINDS = new Set(["dl", "inst", "updt"]);
const ARCHIVE_META_KEY = "meta:last-success";
const ARCHIVE_SUMMARY_KEY = "summary";
const ARCHIVE_TRIGGER_HEADER = "x-archive-token";
const SQL_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// Served from the archive summary's `inst` section: the agreed public display
// number (fresh installs; the pre-2026-09-19 mixed install+update base). Raw
// dl/updt and unique counters stay internal.
async function handleStatsRequest(env: Env): Promise<Response> {
  let installs: Record<string, number> = {};
  try {
    const summary = JSON.parse((await env.PLUGIN_ARCHIVE.get(ARCHIVE_SUMMARY_KEY)) ?? "{}") as Record<string, Record<string, number>>;
    installs = summary.inst ?? {};
  } catch (error) {
    console.error("plugin-stats summary read failed", error);
  }
  return Response.json({ installs }, { headers: { ...CORS_HEADERS, "Cache-Control": "public, max-age=300" } });
}

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

async function recordEvent(env: Env, kind: EventKind, pluginId: string, version: string, identity: string): Promise<void> {
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
  // Stable order across invocations: the resumable cursor is an offset into
  // this array, and the SQL dialect cannot be trusted with ORDER BY.
  return [...byDay]
    .map(([key, uniq]) => {
      const [kind, plugin, day] = key.split(":");
      return { kind, plugin, day, uniq };
    })
    .sort((a, b) => `${a.kind}:${a.plugin}:${a.day}`.localeCompare(`${b.kind}:${b.plugin}:${b.day}`));
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
  // Stable order across invocations (see fetchDailyUniques): the resumable
  // cursor indexes into this array.
  return parseSqlRows(payload)
    .map((row) => ({
      kind: String(row.kind ?? ""),
      plugin: String(row.plugin ?? ""),
      version: String(row.version ?? ""),
      events: Number(row.events ?? 0) || 0,
    }))
    .filter((row) => COUNTED_KINDS.has(row.kind) && PLUGIN_ID_PATTERN.test(row.plugin) && VERSION_PATTERN.test(row.version))
    .sort((a, b) => `${a.kind}:${a.plugin}:${a.version}`.localeCompare(`${b.kind}:${b.plugin}:${b.version}`));
}

// Aggregates events in (last-success, now] into permanent KV totals, chunked
// and resumable. The pre-2026-10 unchunked loop died mid-run once the window
// grew past the Workers per-invocation subrequest ceiling (1000 paid / 50
// free; every versioned total costs a get+put pair). A single failed run then
// left the watermark behind, the next window grew larger, and the aggregation
// stalled permanently (2026-09-28 → 2026-10-20). Now every trigger processes
// at most `chunk` keys, persists a cursor in `agg:state`, and the next cron
// (daily start + */10 continue) resumes until the pass completes; only then
// are the summary written and the watermark advanced. `agg:tuning` carries
// the chunk size across passes — it halves on failure and creeps up on
// progress, so the worker adapts to whatever subrequest/KV limits the
// account has. A crash mid-chunk can double-count that chunk's additive
// totals; acceptable for decorative stats (same stance as v1).
type AggPhase = "counts" | "pluginTotals" | "uniques";
type AggState = { windowFrom: string; windowTo: string; phase: AggPhase; offset: number; chunk: number };

const AGG_STATE_KEY = "agg:state";
const AGG_LOCK_KEY = "agg:lock";
const AGG_TUNING_KEY = "agg:tuning";
const AGG_MIN_CHUNK = 8; // keeps get+put pairs + AE fetches under the free plan's 50 subrequests
const AGG_MAX_CHUNK = 400; // 400×2 + fetches + state writes stays under the paid plan's 1000
const AGG_LOCK_TTL_SECONDS = 300;

async function readChunkSize(env: Env): Promise<number> {
  const chunk = Number.parseInt((await env.PLUGIN_ARCHIVE.get(AGG_TUNING_KEY)) ?? "", 10);
  return Number.isFinite(chunk) && chunk >= AGG_MIN_CHUNK && chunk <= AGG_MAX_CHUNK ? chunk : AGG_MAX_CHUNK;
}

async function runAggregation(env: Env, fromOverride?: string): Promise<
  | { skipped: "locked" }
  | { completed: true; from: string; to: string; activeKeys: number; uniqueDays: number; writes: number }
  | { completed: false; phase: AggPhase; offset: number; of: number; writes: number }
> {
  // Best-effort mutex: cron triggers may overlap and additive totals race.
  if (await env.PLUGIN_ARCHIVE.get(AGG_LOCK_KEY)) return { skipped: "locked" };
  await env.PLUGIN_ARCHIVE.put(AGG_LOCK_KEY, "1", { expirationTtl: AGG_LOCK_TTL_SECONDS });
  try {
    let state: AggState | null = null;
    const rawState = await env.PLUGIN_ARCHIVE.get(AGG_STATE_KEY);
    if (rawState) {
      try {
        state = JSON.parse(rawState) as AggState;
      } catch {
        state = null; // corrupted cursor: start over rather than stay stuck
      }
    }
    if (!state) {
      // `x-archive-from: reset` re-aggregates from the epoch (backfill after
      // a fix); totals are additive, so only use it when the archived window
      // is known-empty.
      const fromOverrideTs = fromOverride?.trim().toLowerCase() === "reset" ? "1970-01-01 00:00:00" : fromOverride?.trim();
      const windowFrom = fromOverrideTs ?? (await env.PLUGIN_ARCHIVE.get(ARCHIVE_META_KEY)) ?? "1970-01-01 00:00:00";
      state = { windowFrom, windowTo: sqlTimestamp(new Date()), phase: "counts", offset: 0, chunk: await readChunkSize(env) };
    }
    const from = new Date(`${state.windowFrom.replace(" ", "T")}Z`);
    const to = new Date(`${state.windowTo.replace(" ", "T")}Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error(`Corrupted aggregation state: ${JSON.stringify(state)}`);

    // Re-fetched every chunk (2 subrequests) so the persisted cursor stays a
    // few bytes and AE remains the single source of truth for the window.
    const [counts, uniques] = await Promise.all([fetchWindowCounts(env, from, to), fetchDailyUniques(env, from, to)]);
    const pluginTotals = new Map<string, number>();
    for (const count of counts) {
      pluginTotals.set(`${count.kind}:${count.plugin}`, (pluginTotals.get(`${count.kind}:${count.plugin}`) ?? 0) + count.events);
    }
    const pluginTotalEntries = [...pluginTotals.entries()];

    let writes = 0;
    if (state.phase === "counts") {
      for (const count of counts.slice(state.offset, state.offset + state.chunk)) {
        const totalKey = `total:${count.kind}:${count.plugin}:${count.version}`;
        const current = Number.parseInt((await env.PLUGIN_ARCHIVE.get(totalKey)) ?? "0", 10) || 0;
        await env.PLUGIN_ARCHIVE.put(totalKey, String(current + count.events));
        writes += 2;
      }
      state.offset += Math.min(state.chunk, Math.max(0, counts.length - state.offset));
      if (state.offset >= counts.length) state = { ...state, phase: "pluginTotals", offset: 0 };
    } else if (state.phase === "pluginTotals") {
      for (const [pair, delta] of pluginTotalEntries.slice(state.offset, state.offset + state.chunk)) {
        const [kind, plugin] = pair.split(":");
        const pluginKey = `total:${kind}:${plugin}`;
        const current = Number.parseInt((await env.PLUGIN_ARCHIVE.get(pluginKey)) ?? "0", 10) || 0;
        await env.PLUGIN_ARCHIVE.put(pluginKey, String(current + delta));
        writes += 2;
      }
      state.offset += Math.min(state.chunk, Math.max(0, pluginTotalEntries.length - state.offset));
      if (state.offset >= pluginTotalEntries.length) state = { ...state, phase: "uniques", offset: 0 };
    } else {
      // Daily uniques overwrite (not add): reruns converge to the full-day
      // value, and multi-version releases cannot inflate the downloader count.
      for (const unique of uniques.slice(state.offset, state.offset + state.chunk)) {
        await env.PLUGIN_ARCHIVE.put(`uniqd:${unique.kind}:${unique.plugin}:${unique.day}`, String(unique.uniq));
        writes += 1;
      }
      state.offset += Math.min(state.chunk, Math.max(0, uniques.length - state.offset));
      if (state.offset >= uniques.length) {
        const summary = JSON.parse((await env.PLUGIN_ARCHIVE.get(ARCHIVE_SUMMARY_KEY)) ?? "{}") as Record<string, Record<string, number>>;
        for (const count of counts) {
          const byKind = (summary[count.kind] ??= {});
          byKind[count.plugin] = (byKind[count.plugin] ?? 0) + count.events;
        }
        await env.PLUGIN_ARCHIVE.put(ARCHIVE_SUMMARY_KEY, JSON.stringify(summary));
        await env.PLUGIN_ARCHIVE.put(ARCHIVE_META_KEY, state.windowTo);
        await env.PLUGIN_ARCHIVE.delete(AGG_STATE_KEY);
        await env.PLUGIN_ARCHIVE.put(AGG_TUNING_KEY, String(Math.min(AGG_MAX_CHUNK, Math.ceil(state.chunk * 1.25))));
        return { completed: true, from: state.windowFrom, to: state.windowTo, activeKeys: counts.length, uniqueDays: uniques.length, writes };
      }
    }

    state.chunk = Math.min(AGG_MAX_CHUNK, state.chunk + 1);
    await env.PLUGIN_ARCHIVE.put(AGG_STATE_KEY, JSON.stringify(state));
    const of = state.phase === "counts" ? counts.length : state.phase === "pluginTotals" ? pluginTotalEntries.length : uniques.length;
    return { completed: false, phase: state.phase, offset: state.offset, of, writes };
  } catch (error) {
    // Halve the persisted chunk so the next trigger retries smaller; the
    // cursor itself stays put (idempotent enough for decorative counters).
    try {
      const rawState = await env.PLUGIN_ARCHIVE.get(AGG_STATE_KEY);
      if (rawState) {
        const st = JSON.parse(rawState) as AggState;
        st.chunk = Math.max(AGG_MIN_CHUNK, Math.floor(st.chunk / 2));
        await env.PLUGIN_ARCHIVE.put(AGG_STATE_KEY, JSON.stringify(st));
      }
    } catch {
      // best-effort tuning write; the error below is the real signal
    }
    throw error;
  } finally {
    await env.PLUGIN_ARCHIVE.delete(AGG_LOCK_KEY);
  }
}

async function handleInstallBeacon(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return emptyResponse(204);

  const url = new URL(request.url);
  if (url.pathname === "/api/plugins/stats") {
    if (request.method !== "GET" && request.method !== "HEAD") return emptyResponse(405);
    return handleStatsRequest(env);
  }
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
  const { id, version, kind, clientId } = (payload ?? {}) as Record<string, unknown>;
  if (typeof id !== "string" || !PLUGIN_ID_PATTERN.test(id)) return emptyResponse(400);
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) return emptyResponse(400);
  // `kind:"update"` classifies version updates separately; every other value
  // (including the absent field on legacy beacons) counts as a fresh install so
  // the historical mixed-event base stays continuous until the fleet upgrades.
  const eventKind: "inst" | "updt" = kind === "update" ? "updt" : "inst";
  // The app's random installation id gives stable per-machine uniques; legacy
  // beacons fall back to the day-scoped IP HMAC.
  const identity = typeof clientId === "string" && CLIENT_ID_PATTERN.test(clientId) ? clientId : await ipDayIdentity(env, request);

  await recordEvent(env, eventKind, id, version, identity);
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
