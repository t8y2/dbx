# etcd v2 native agent (`etcd2`)

Native Go agent speaking the etcd **v2 HTTP/JSON API** with the standard DBX
agent protocol (NDJSON JSON-RPC over stdio). Registered as agentKey `etcd2`,
selected through the `etcd-v2` driver profile of the `etcd` connection type.

## Supported servers

| Server | Support |
| --- | --- |
| etcd 2.0–2.3 (pure v2) | fully supported; validated against 2.3.8 |
| etcd 3.0–3.5 started with `--enable-v2` | same code path |
| etcd 3.4–3.5 default configuration | rejected at connect: v2 is disabled by default (`ETCD_V2_API_DISABLED`) |
| etcd 3.6+ | impossible: the v2 API was removed upstream |

## Capabilities

`connect`, `test_connection`, `kv`, `kv_ttl`, `kv_cas`, `kv_list_values`,
`kv_status`, `etcd_watch`, `etcd_auth`, `multi_session`. The v3-only
capabilities (`kv_history`, `etcd_lease`, `etcd_compaction`, `etcd_defrag`)
are deliberately absent; the host blocks those calls before dispatch and the
UI hides the corresponding workspaces for `etcd-v2` connections.

## v2 API semantics and deliberate limits

- **TTL**: v2 attaches TTLs directly to keys (`?ttl=`). Key editing offers
  permanent/TTL expiry only; binding a lease is rejected with
  `ETCD_V2_LEASE_UNSUPPORTED` because v2 has no lease concept.
- **CAS**: writes use `prevIndex` (modifiedIndex) and `prevExist`, matching
  the v3 modRevision contract. `expectedCreateRevision` is only honored when
  `0` (key-must-not-exist); a nonzero value is rejected with
  `ETCD_V2_CAS_UNSUPPORTED` because v2 does not expose createdIndex for
  compare-and-swap.
- **Rename**: check-then-set, **not atomic** — v2 has no transaction
  primitive. The source is verified by CAS before the target is created, but
  a concurrent writer between the two requests is not serialized.
- **Watch**: long-poll loop (`?wait=true&waitIndex=N`, recursive for prefix
  scopes). Idle poll timeouts are retried transparently. There are no
  progress notifications; the same batch/event/byte budget system as the v3
  agent applies.
- **Hidden directories**: v2 hides `_`-prefixed directory entries from
  non-recursive listings; such keys are only reachable when addressed
  explicitly, matching `etcdctl` behavior.
- **Auth**: users hold roles; roles hold read/write permissions over exact
  keys and `/prefix/*` globs. Grants and revokes use the server's incremental
  `grant`/`revoke` role PUT (`{"role":"r","grant":{"kv":{"read":["/p/*"]}}}`),
  matching the etcd 2.3 client wire format. Resource mapping: `key` → bare
  path, `prefix`/`all` → `/path/*` / `/*` globs.
- **Status**: reduced dashboard. `clusterId` comes from the
  `X-Etcd-Cluster-Id` header, `revision` from `X-Etcd-Index`; Prometheus
  metrics, alarms, dbSize, and raft details do not exist in v2 and stay null.
  Raw `/v2/stats/store` counters are passed through as the `store` object.

## Connect probing

`connect` fetches `/version`, then probes `GET /v2/members`:

- `200` → ok; `403` → ok with `limited: true` (credentials work, root access
  missing); `404` → `ETCD_V2_API_DISABLED`; `401` → `ETCD_UNAUTHENTICATED`.

## Testing

```bash
go test ./...                                  # unit tests
DBX_ETCD2_LIVE=1 go test -run Live ./...       # live flow (default endpoint below)
```

Live test environment variables: `DBX_ETCD2_ENDPOINTS`, `DBX_ETCD2_USER`,
`DBX_ETCD2_PASSWORD`. The default endpoint points at the team test server's
etcd 2.3.8 instance; see `docs/testing-databases.md` in the workspace root.
