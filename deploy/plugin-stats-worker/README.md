# plugin-stats-worker

Cloudflare Worker that counts plugin marketplace traffic. Deployed on the same
Cloudflare account as the dbxio.com site (`npx wrangler deploy` from this
directory; OAuth login required).

## Routes

- `dl.dbxio.com/plugins/*` — counts every `GET` of a real `.dbxp` artifact
  (icons and other static assets under the same prefix are excluded: they are
  fetched on every marketplace page/app view, which both burned KV quota and
  inflated the numbers), then passes the request through to the R2 custom
  domain. Artifact bytes, headers, and Range semantics are untouched.
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

## Storage — Workers Analytics Engine

One datapoint per event (binding `PLUGIN_STATS`):

- `blobs = [kind, pluginId, version, identity]` where kind is `dl` (artifact
  GET), `inst` (fresh install; legacy beacons without `kind` also land here so
  the historical mixed-event base stays continuous) or `updt` (version update);
  `identity` is the beacon `clientId` when present (stable per-machine unique),
  otherwise a day-scoped IP HMAC (all `dl` events use the latter).
  `doubles = [1]`; `indexes = [pluginId]`.

Chosen over KV counters: KV read-modify-write costs 1 write per request, and
the free tier's 1k writes/day is below what a 30k-user base generates on a hot
plugin release day (2026-09-15: icon traffic blew the quota within hours).
Analytics Engine writes are effectively free at this scale.

## Daily aggregation (permanent archive)

AE retains only three months, so a cron trigger (`30 0 * * *` UTC) aggregates the
trailing window into the `plugin_stats_archive` KV namespace — the permanent
layer future UI reads:

- `total:{kind}:{pluginId}:{version}` — all-time cumulative events
- `summary` — one JSON blob `{dl: {pluginId: n}, inst: {...}, updt: {...}}` for
  single-read display; `inst` carries the pre-2026-09-19 mixed install+update
  base (the switch to classified kinds), so treat it as the display number
- `uniqd:{kind}:{pluginId}:{day}` — per-day distinct identities (machines for
  classified inst/updt events, distinct downloaders for dl)
- `meta:last-success` — window marker; only advanced after all writes land, so a
  failed run retries the same window on the next cron

Required secret (SQL API access; OAuth login does not carry analytics scope):

```sh
echo "<token>" | npx wrangler secret put ANALYTICS_TOKEN
```

Create the token in the dashboard with **Account → Analytics → Read**. The same
token authorizes the manual trigger (verification / backfill):

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
