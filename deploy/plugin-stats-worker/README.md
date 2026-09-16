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
  (`{"id": "<plugin id>", "version": "<version>"}`, 204 on accept). Decorative
  statistics only: no auth, no PII.

## Storage — Workers Analytics Engine

One datapoint per event (binding `PLUGIN_STATS`):

- `blobs = [kind, pluginId, version]` where kind is `dl` (artifact GET) or
  `inst` (install beacon); `doubles = [1]`; `indexes = [pluginId]`.

Chosen over KV counters: KV read-modify-write costs 1 write per request, and
the free tier's 1k writes/day is below what a 30k-user base generates on a hot
plugin release day (2026-09-15: icon traffic blew the quota within hours).
Analytics Engine writes are effectively free at this scale.

## Daily aggregation (permanent archive)

AE retains only three months, so a cron trigger (`30 0 * * *` UTC) aggregates the
trailing window into the `plugin_stats_archive` KV namespace — the permanent
layer future UI reads:

- `total:{kind}:{pluginId}:{version}` — all-time cumulative events
- `summary` — one JSON blob `{dl: {pluginId: n}, inst: {...}}` for single-read display
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

No HTTP stats endpoint (there is no consumer yet; add one when the marketplace
UI ships). Query via the SQL REST API with an API token that has
Account → Analytics → Read:

```sh
curl -s "https://api.cloudflare.com/client/v4/accounts/<account_id>/analytics_engine/sql" \
  -H "Authorization: Bearer <token>" \
  --data-urlencode "query=SELECT blob1 AS kind, blob2 AS plugin, blob3 AS version, SUM(_sample_interval) AS events FROM DBX_PLUGIN_STATS WHERE timestamp > NOW() - INTERVAL '7' DAY GROUP BY 1,2,3 ORDER BY events DESC"
```

At current volume sampling is 1:1, so `SUM(_sample_interval)` equals the event
count. Counters start from the Analytics Engine migration; the polluted KV-era
numbers (`plugin_stats` namespace) were discarded.
