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

- `archive:v2` — **one** JSON document holding every counter:
  `{v:2, lastSuccess, total:{"kind:pluginId:version": n}, uniqd:{"kind:pluginId:day": n}}`
  (plus `kind:pluginId` rollups inside `total`). A pass reads it once, folds in
  the window, writes it back — the number of distinct keys touched per pass is
  constant (archive + summary + lock) no matter how many plugins exist.
- `summary` — one JSON blob `{dl: {pluginId: n}, inst: {...}, updt: {...}}` for
  single-read display; `inst` carries the pre-2026-09-19 mixed install+update
  base (the switch to classified kinds), so treat it as the display number.
- `agg:lock` — best-effort mutex; overlapping crons would otherwise
  read-modify-write the same document and lose one side of the update.

**Why one document** (2026-11-10). The previous layout used one key per counter
(`total:{kind}:{pluginId}:{version}`, `uniqd:{kind}:{pluginId}:{day}`) and
rewrote each touched key per pass. The Workers free plan caps writes to
*different keys* at 1,000/day, so a catch-up window that touched a few hundred
counters consumed the day's allowance; every later retry then failed mid-pass,
the resumable cursor could not advance, the window kept growing, and the next
day blew the cap earlier still. On 2026-11-10 the 12:00 UTC pass hit the cap
after ~800 distinct keys and the archive stalled with a growing backlog. Under
the single-document model a pass needs `get` + `put` on one value, so history
cannot starve the quota.

The remaining ceiling is the value, not the key count: the document is ~450 KiB
today (4,279 counters + 7,213 unique-days) and a full read-modify-write costs
roughly 4–5 ms of the free plan's 10 ms CPU budget. Past ~1–2 MB (a few thousand
plugins) split `archive:v2` by kind into separate documents, and past that move
the per-version detail to D1. Pruning `uniqd:` entries older than ~90 days
reclaims most of the growth in the meantime.

**Migrating the legacy keys.** `migrate-archive.mjs` reads every legacy key
(bulk get), builds the document, verifies every value, and — with `--apply` —
uploads it and re-reads it to diff. It never deletes the legacy keys, so the old
layout stays as a read-only backup:

```sh
node migrate-archive.mjs              # dry run: verify + dump the document
node migrate-archive.mjs --apply      # write archive:v2 and verify read-back
```

Run the migration *before* deploying a Worker whose aggregation expects
`archive:v2`; the new code refuses to aggregate when the document is missing
(`{"skipped":"unmigrated"}`) instead of silently starting from zero. Legacy keys
can be deleted later at 1,000 deletes/day (free plan) or left in place.

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
