// Counts plugin marketplace installs on Cloudflare. Statistics are decorative:
// they must never sit in the artifact download path.
//
// Routes (see wrangler.json):
// - dbxio.com/api/plugins/install: fire-and-forget beacon the desktop app can
//   send after a successful marketplace install.
// - dbxio.com/api/plugins/stats: public read of the display counters (installs
//   per plugin) from the archive summary — consumed by the website cards.
// - dbxio.com/api/plugins/archive: token-gated manual trigger for the daily
//   aggregation (same handler the cron runs), for verification and backfills.
//
// Do not add a dl.dbxio.com route back. That route proxied every artifact GET
// through this Worker; when the Workers free-tier daily request quota was
// exhausted, downloads failed with HTTP 429 and plugin installation broke for
// everyone. Artifact downloads are counted out-of-band instead: the aggregation
// reads the zone's edge request analytics (GraphQL `httpRequestsAdaptiveGroups`),
// so nothing sits in the download path and nothing can fail a download.
//
// Event kinds (blob1 in Analytics Engine, and the keys in the archive):
// - inst: fresh install (beacon `kind:"install"`); legacy beacons without a
//         kind also land here — they keep feeding the historical mixed-event
//         base until the fleet upgrades, so the inst curve stays comparable
// - updt: version update (beacon `kind:"update"`)
// - dl:   completed `.dbxp` artifact download. Not an Analytics Engine event
//         any more: counted from edge analytics (HTTP 200 responses only —
//         429s, 206 resume fragments and 304s are not downloads) at
//         aggregation time. Counts are sampled estimates; legacy `dl` events
//         still sitting in Analytics Engine are ignored so the same window is
//         never counted twice.
//
// Identity (blob4, only used for per-day unique counts):
// - inst/updt events carry the app's anonymous random installation id when
//   available (stable across days → true per-machine uniques)
// - legacy beacons fall back to a day-scoped IP HMAC
//
// Storage:
// - Workers Analytics Engine (binding PLUGIN_STATS) — one datapoint per event.
//   AE only retains three months, so cron aggregates the trailing window into
//   the `plugin_stats_archive` KV namespace, which holds the permanent totals
//   as ONE document (see ARCHIVE_KEY). A pass therefore writes a constant
//   number of distinct keys, which keeps it inside the free plan's
//   1,000-different-keys/day cap no matter how many plugins exist.

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
  CF_ZONE_ID: string;
  STATS_SALT: string;
};

type EventKind = "inst" | "updt";

const DOWNLOAD_HOST = "dl.dbxio.com";
const DOWNLOAD_PATH_PATTERN = /^\/plugins\/([A-Za-z0-9._-]{1,64})\/([0-9A-Za-z.+-]{1,32})\/[^/]+\.dbxp$/;
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/;
const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTALL_BODY_LIMIT_BYTES = 512;
// Kinds read from Analytics Engine. `dl` is deliberately absent: it comes from
// edge analytics (see fetchDownloadCounts).
const COUNTED_KINDS = new Set(["inst", "updt"]);
const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
// Free-plan limits of httpRequestsAdaptiveGroups: 30 days per query, 10000 rows.
const GRAPHQL_MAX_WINDOW_MS = 29 * 24 * 60 * 60 * 1000;
const GRAPHQL_ROW_LIMIT = 10000;
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

// Completed `.dbxp` downloads in (from, to] from the zone's edge request
// analytics. Only HTTP 200 counts: 429/5xx are failures, 206 are Range resume
// fragments of a download already counted at its 200, 304 are revalidations.
// `count` is already scaled for adaptive sampling. A window longer than the
// plan's 30-day query limit is clamped to its most recent part.
async function fetchDownloadCounts(env: Env, from: Date, to: Date): Promise<WindowCount[]> {
  const earliest = new Date(to.getTime() - GRAPHQL_MAX_WINDOW_MS);
  const start = from < earliest ? earliest : from;
  const query = `query($zone: String!, $since: Time!, $until: Time!) {
    viewer { zones(filter: { zoneTag: $zone }) {
      httpRequestsAdaptiveGroups(
        limit: ${GRAPHQL_ROW_LIMIT},
        filter: {
          datetime_gt: $since, datetime_leq: $until,
          clientRequestHTTPHost: ${JSON.stringify(DOWNLOAD_HOST)},
          clientRequestPath_like: "/plugins/%.dbxp",
          edgeResponseStatus: 200,
          requestSource: "eyeball"
        }
      ) { count dimensions { clientRequestPath } }
    } }
  }`;
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ANALYTICS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: { zone: env.CF_ZONE_ID, since: start.toISOString(), until: to.toISOString() },
    }),
  });
  if (!response.ok) {
    throw new Error(`Analytics GraphQL API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const payload = (await response.json()) as {
    data?: { viewer?: { zones?: Array<{ httpRequestsAdaptiveGroups?: Array<{ count?: number; dimensions?: { clientRequestPath?: string } }> }> } };
    errors?: Array<{ message?: string }> | null;
  };
  // GraphQL reports permission/schema problems as HTTP 200 with `errors`; a
  // token without Zone → Analytics → Read must fail loudly, not count zero.
  if (payload.errors?.length) {
    throw new Error(`Analytics GraphQL errors: ${payload.errors.map((error) => error.message).join("; ").slice(0, 300)}`);
  }
  const groups = payload.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups;
  if (!groups) throw new Error("Analytics GraphQL response has no httpRequestsAdaptiveGroups for the zone");
  if (groups.length >= GRAPHQL_ROW_LIMIT) {
    throw new Error(`Analytics GraphQL returned ${groups.length} rows (limit ${GRAPHQL_ROW_LIMIT}); download counts would be truncated`);
  }
  const byVersion = new Map<string, WindowCount>();
  for (const group of groups) {
    const match = DOWNLOAD_PATH_PATTERN.exec(group.dimensions?.clientRequestPath ?? "");
    const count = Number(group.count ?? 0) || 0;
    if (!match || count <= 0) continue;
    const key = `${match[1]}:${match[2]}`;
    const entry = byVersion.get(key) ?? { kind: "dl", plugin: match[1], version: match[2], events: 0 };
    entry.events += count;
    byVersion.set(key, entry);
  }
  return [...byVersion.values()];
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
  const eventCounts = parseSqlRows(payload)
    .map((row) => ({
      kind: String(row.kind ?? ""),
      plugin: String(row.plugin ?? ""),
      version: String(row.version ?? ""),
      events: Number(row.events ?? 0) || 0,
    }))
    .filter((row) => COUNTED_KINDS.has(row.kind) && PLUGIN_ID_PATTERN.test(row.plugin) && VERSION_PATTERN.test(row.version));
  return [...eventCounts, ...(await fetchDownloadCounts(env, from, to))]
    .sort((a, b) => `${a.kind}:${a.plugin}:${a.version}`.localeCompare(`${b.kind}:${b.plugin}:${b.version}`));
}

// ---------------------------------------------------------------------------
// Permanent archive: ONE KV value holds every cumulative counter.
//
// The previous model stored one key per counter (`total:kind:plugin:version`,
// `uniqd:kind:plugin:day`). Every aggregation pass then wrote one *different*
// key per counter it touched. On the free plan the cap is "writes to different
// keys: 1,000/day", so a catch-up window touching a few hundred counters ate
// the day's allowance; after that every retry failed mid-pass, the resumable
// cursor could not advance, the window kept growing, and the next day blew the
// cap earlier still. Now a pass reads one value, mutates it in memory and
// writes it back, so the number of distinct keys it touches (archive, summary,
// lock) is constant and independent of the plugin count. The remaining ceiling
// is value size / JSON CPU cost, not the key count (see README).
export const ARCHIVE_KEY = "archive:v2";
const ARCHIVE_VERSION = 2;
const ARCHIVE_EPOCH = "1970-01-01 00:00:00";

export type ArchiveDoc = {
  v: number;
  /** SQL timestamp of the last completed window; "" until the first pass. */
  lastSuccess: string;
  /** "kind:plugin:version" -> cumulative events. */
  total: Record<string, number>;
  /** "kind:plugin:day" -> distinct identities seen that day. */
  uniqd: Record<string, number>;
};

/** `{kind: {plugin: count}}`, exactly what the website reads. */
export type Summary = Record<string, Record<string, number>>;

const AGG_LOCK_KEY = "agg:lock";
const AGG_LOCK_TTL_SECONDS = 300;

export function emptyArchive(): ArchiveDoc {
  return { v: ARCHIVE_VERSION, lastSuccess: "", total: {}, uniqd: {} };
}

/** Parse a stored archive; an unknown schema throws instead of resetting data. */
export function parseArchive(raw: string): ArchiveDoc {
  const parsed = JSON.parse(raw) as Partial<ArchiveDoc> | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("archive: stored value is not an object");
  if (parsed.v !== ARCHIVE_VERSION) throw new Error(`archive: unsupported version ${String(parsed.v)}`);
  const total = parsed.total ?? {};
  const uniqd = parsed.uniqd ?? {};
  if (typeof total !== "object" || Array.isArray(total) || typeof uniqd !== "object" || Array.isArray(uniqd)) {
    throw new Error("archive: malformed counters");
  }
  return {
    v: ARCHIVE_VERSION,
    lastSuccess: typeof parsed.lastSuccess === "string" ? parsed.lastSuccess : "",
    total: total as Record<string, number>,
    uniqd: uniqd as Record<string, number>,
  };
}

/** Fold one window into the archive. Event counters add; per-day uniques overwrite. */
export function applyWindow(doc: ArchiveDoc, counts: WindowCount[], uniques: DailyUnique[]): void {
  for (const count of counts) {
    const key = `${count.kind}:${count.plugin}:${count.version}`;
    doc.total[key] = (doc.total[key] ?? 0) + count.events;
  }
  for (const unique of uniques) {
    // Overwrite, not add: reruns converge to the full-day value and
    // multi-version releases cannot inflate the downloader count.
    doc.uniqd[`${unique.kind}:${unique.plugin}:${unique.day}`] = unique.uniq;
  }
}

/** Fold the same window into the public summary (`inst` feeds the website cards). */
export function applySummary(summary: Summary, counts: WindowCount[]): void {
  for (const count of counts) {
    const byKind = (summary[count.kind] ??= {});
    byKind[count.plugin] = (byKind[count.plugin] ?? 0) + count.events;
  }
}

async function readArchive(env: Env): Promise<ArchiveDoc | null> {
  const raw = await env.PLUGIN_ARCHIVE.get(ARCHIVE_KEY);
  return raw === null ? null : parseArchive(raw);
}

async function readSummary(env: Env): Promise<Summary> {
  const raw = await env.PLUGIN_ARCHIVE.get(ARCHIVE_SUMMARY_KEY);
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as Summary;
  } catch (error) {
    // A corrupted summary must not block the archive; it is rebuilt from the
    // `inst` deltas of later passes (display numbers are decorative).
    console.error("plugin-stats summary parse failed", error);
    return {};
  }
}

export type AggregationResult =
  | { skipped: "locked" }
  | { skipped: "unmigrated"; hint: string }
  | { skipped: "empty-window"; from: string; to: string }
  | { completed: true; from: string; to: string; counters: number; uniqueDays: number };

// One pass: read the archive, fold in everything Analytics Engine and edge
// analytics have for (lastSuccess, now], write it back. No cursor and no
// chunking — the write count is constant, so an arbitrarily large backlog
// cannot run out of subrequests.
async function runAggregation(env: Env, fromOverride?: string): Promise<AggregationResult> {
  // Best-effort mutex: overlapping crons would otherwise read-modify-write the
  // same archive and lose one side of the update.
  if (await env.PLUGIN_ARCHIVE.get(AGG_LOCK_KEY)) return { skipped: "locked" };
  await env.PLUGIN_ARCHIVE.put(AGG_LOCK_KEY, "1", { expirationTtl: AGG_LOCK_TTL_SECONDS });
  try {
    const archive = await readArchive(env);
    if (!archive) {
      // Never start from an empty archive: that would look like a successful
      // pass and silently reset the counters. The one-shot migration writes
      // ARCHIVE_KEY before this Worker handles traffic.
      return { skipped: "unmigrated", hint: "run deploy/plugin-stats-worker/migrate-archive.mjs --apply" };
    }

    const trimmed = fromOverride?.trim().toLowerCase();
    const override = trimmed === "reset" ? ARCHIVE_EPOCH : trimmed || undefined;
    const windowFrom = override ?? (archive.lastSuccess || ARCHIVE_EPOCH);
    const from = new Date(`${windowFrom.replace(" ", "T")}Z`);
    const to = new Date();
    if (Number.isNaN(from.getTime())) throw new Error(`archive: corrupted lastSuccess ${JSON.stringify(archive.lastSuccess)}`);
    if (from >= to) return { skipped: "empty-window", from: windowFrom, to: sqlTimestamp(to) };

    const [counts, uniques] = await Promise.all([fetchWindowCounts(env, from, to), fetchDailyUniques(env, from, to)]);

    // Summary first, watermark last. A crash in between re-adds the window on
    // the next pass (double-counted display numbers) instead of undercounting
    // it; the archive itself only advances together with its watermark.
    const summary = await readSummary(env);
    applySummary(summary, counts);
    await env.PLUGIN_ARCHIVE.put(ARCHIVE_SUMMARY_KEY, JSON.stringify(summary));

    applyWindow(archive, counts, uniques);
    archive.lastSuccess = sqlTimestamp(to);
    await env.PLUGIN_ARCHIVE.put(ARCHIVE_KEY, JSON.stringify(archive));

    return {
      completed: true,
      from: windowFrom,
      to: archive.lastSuccess,
      counters: counts.length,
      uniqueDays: uniques.length,
    };
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
