# plugin-stats-worker

Cloudflare Worker that counts plugin marketplace installs. Deployed on the same
Cloudflare account as the dbxio.com site (`npx wrangler deploy` from this
directory; OAuth login required).

## Routes

- `dbxio.com/api/plugins/install` — `POST` fire-and-forget beacon the desktop
  app can send after a successful marketplace install
  (`{"id": "<plugin id>", "version": "<version>", "kind": "install"|"update",
  "clientId": "<random uuid>"}`, 204 on accept; `kind` and `clientId` are
  optional and absent on legacy app versions). Decorative statistics only: no
  auth, no PII — `clientId` is a purely random per-installation id the app
  generates locally, not a hardware or user fingerprint.
- `dbxio.com/api/plugins/stats` — `GET` public display counters for the
  website: `{"installs": {"<plugin id>": <n>}}` read from the archive
  summary's `inst` section only (dl/updt and unique counts stay internal).
  Cached for 5 minutes.

### Why artifact downloads are not routed here

An earlier version also matched `dl.dbxio.com/plugins/*` to count `.dbxp`
downloads. That put a Worker invocation in front of every plugin artifact (and
every icon under the prefix). When the Workers free-tier daily request quota
was exhausted, the edge returned HTTP 429 for the whole route and every plugin
installation failed — even though the statistics are decorative. The route was
removed so R2 serves artifacts directly. Do not add it back.

Downloads are still counted, out of band: the aggregation queries the zone's
edge request analytics (GraphQL `httpRequestsAdaptiveGroups`, filtered to
`dl.dbxio.com`, `/plugins/%.dbxp`, `edgeResponseStatus = 200`) and writes the
result into the archive as `dl`. Only HTTP 200 counts — 429/5xx are failures,
206 are Range resume fragments of a download already counted, 304 are
revalidations. Numbers are adaptive-sampling estimates, and per-day distinct
downloaders are no longer tracked (edge analytics has no stable identity).
The free plan allows 29-day windows per query (the code clamps longer ones), so
a stalled aggregation older than that loses the oldest `dl` days. A failing
GraphQL call fails the whole pass, same as the SQL API calls.

## Storage — Workers Analytics Engine

One datapoint per event (binding `PLUGIN_STATS`):

- `blobs = [kind, pluginId, version, identity]` where kind is `inst` (fresh
  install; legacy beacons without `kind` also land here so the historical
  mixed-event base stays continuous) or `updt` (version update). Legacy
  `dl` rows written before the artifact route was removed are ignored (see
  above).
  `identity` is the beacon `clientId` when present (stable per-machine unique),
  otherwise a day-scoped IP HMAC. `doubles = [1]`; `indexes = [pluginId]`.

Chosen over KV counters: KV read-modify-write costs 1 write per request, and
the free tier's 1k writes/day is below what a 30k-user base generates on a hot
plugin release day (2026-09-15: icon traffic blew the quota within hours).
Analytics Engine writes are effectively free at this scale.

## Daily aggregation (permanent archive)

AE retains only three months, so cron triggers aggregate the trailing window
into the `plugin_stats_archive` KV namespace — the permanent layer future UI
reads:

- `total:{kind}:{pluginId}:{version}` — all-time cumulative events
- `summary` — one JSON blob `{dl: {pluginId: n}, inst: {...}, updt: {...}}` for
  single-read display; `inst` carries the pre-2026-09-19 mixed install+update
  base (the switch to classified kinds), so treat it as the display number
- `uniqd:{kind}:{pluginId}:{day}` — per-day distinct identities (machines for
  classified inst/updt events; no longer written for dl)
- `meta:last-success` — window marker; only advanced after all writes land, so a
  failed run retries the same window on the next cron
- `agg:state` / `agg:tuning` / `agg:lock` — resumable-pass cursor, adaptive
  chunk size, and best-effort mutex (see below)

**Chunked resumable passes** (added 2026-10-20). The original single-shot loop
needed one KV get+put pair per aggregated key; once a failed window grew the
retry backlog past the Workers per-invocation subrequest ceiling (1000 paid /
50 free), every run died mid-loop and the watermark never advanced — the
aggregation stalled silently for three weeks (2026-09-28 → 2026-10-20) while
raw AE data kept flowing. Now every invocation processes at most `chunk` keys
(tuning halves on failure, creeps up on success, 8–400), persists its cursor in
`agg:state`, and completes the summary write + watermark advance only when the
pass finishes. Crons: `30 0 * * *` opens the day's window, `0 * * * *`
resumes any in-flight pass (a normal window finishes in a few ticks ≈ hours;
the hourly cadence keeps daily KV writes under the free-plan 1000/day alert
line — freshness is a decorative concern here, raise the frequency only if
display latency starts to matter). AE row order is normalized with a JS sort because
the offset cursor must index identically across invocations. Required
subrequests per invocation: `chunk`-bounded (~2·chunk + 6) — never the whole
backlog. After deploying schema-affecting changes, or to backfill from scratch,
pass `x-archive-from: reset` (totals are additive — only safe when the
archive is known-empty).

Required secret (SQL API access; OAuth login does not carry analytics scope):

```sh
echo "<token>" | npx wrangler secret put ANALYTICS_TOKEN
```

Create the token in the dashboard with **Account → Analytics → Read** and
**Zone → Analytics → Read** (zone `dbxio.com`; the edge request analytics used for
`dl` counts need the zone scope). `CF_ZONE_ID` is a plain var in `wrangler.json`.
The same token authorizes the manual trigger (verification / backfill):

```sh
curl -s -X POST https://dbxio.com/api/plugins/archive -H "x-archive-token: <token>"
```

## Reading counters

The website reads the display number via `GET dbxio.com/api/plugins/stats`
(installs per plugin, served from the archive summary). For anything richer,
query the SQL REST API directly with an API token that has
Account → Analytics → Read:

```sh
curl -s "https://api.cloudflare.com/client/v4/accounts/<account_id>/analytics_engine/sql" \
  -H "Authorization: Bearer <token>" \
  --data-urlencode "query=SELECT blob1 AS kind, blob2 AS plugin, blob3 AS version, SUM(_sample_interval) AS events FROM DBX_PLUGIN_STATS WHERE timestamp > NOW() - INTERVAL '7' DAY GROUP BY 1,2,3 ORDER BY events DESC"
```

At current volume sampling is 1:1, so `SUM(_sample_interval)` equals the event
count. Counters start from the Analytics Engine migration; the polluted KV-era
numbers (`plugin_stats` namespace) were discarded.
