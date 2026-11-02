# etcd Java to Go migration parity

Status date: 2026-09-02.

The Java `EtcdAgent` (jetcd 0.8.x, 33 protocol methods) was replaced by this
native Go agent. The migration is complete only where a capability is
implemented, covered by automated tests, validated against a real etcd cluster,
and wired into the native build and release path.

## Baseline

- DBX Java baseline: jetcd 0.8.x `EtcdAgent`; all protocol shapes, capability
  strings, and error signal texts were copied verbatim.
- Go client: `go.etcd.io/etcd/client/v3` v3.7.1 over gRPC.
- Capabilities (exact Java set, no `structured_error_v1`): `connect`,
  `test_connection`, `kv`, `kv_ttl`, `kv_cas`, `kv_list_values`, `kv_status`,
  `kv_history`, `etcd_compaction`, `etcd_defrag`, `etcd_watch`, `etcd_lease`,
  `etcd_auth`, `multi_session`.
- Error signal strings (`ETCD_CAS_CONFLICT`, `ETCD_NOT_FOUND`,
  `ETCD_COMPACTED`, `ETCD_WATCH_LIMIT`, …) are matched verbatim because the
  host normalizes agent errors by message text
  (`agent_kv.rs::normalize_agent_kv_error`).
- The shared `go-semver` module is vendored under `agents/go-common/go-semver`
  because the upstream `v0.3.1` tag declares a broken module path.

## Current matrix

| Capability | Go code | Automated | Live server | Status |
| --- | --- | --- | --- | --- |
| connect / endpoints / TLS / basic auth | yes | yes | etcd 3.7.0, 3.5.21 | parity passed (auth enabled) |
| test_connection probe (PERMISSION_DENIED → limited) | yes | yes | yes | parity passed |
| kv list/get/put/delete/rename with CAS | yes | yes | yes | parity passed |
| TTL + preserveLease (3-attempt retry) | yes | yes | yes | parity passed |
| Lease list/get/grant/keepalive/revoke | yes | yes | yes | parity passed |
| LeaseLeases fallback on 3.3 (UNIMPLEMENTED/timeout → partial) | yes | yes | n/a (3.3 fixture not retained) | coded + unit tested |
| LeaseGrant with custom ID (raw etcdserverpb RPC) | yes | yes | yes | replaces Java reflection wire handling |
| kv_history (temporary watch, prevKV, progress notify) | yes | yes | yes | requires `clientv3.WithCreatedNotify()`; jetcd parity |
| kv_history compacted/future-revision errors | yes | yes | yes | parity passed |
| Watch start/poll/stop with full budget system | yes | yes | yes | 256 batches / 10k events / 8MiB per watch, 16MiB session aggregate |
| Status: members, alarms, latency fan-out, member dedup | yes | yes | yes | parity passed |
| Status raft fields as unsigned decimal strings | yes | yes | yes | bit-level parity with Java `longString(int64(uint64))` |
| Compaction (pre-validation, error propagation) | yes | yes | yes | Java check order preserved (params before connect) |
| Defrag (followers first, leader last, per-endpoint errors) | yes | yes | yes | parity passed |
| Auth users/roles (14 methods) | yes | yes | yes | parity passed |
| Multi-session protocol runtime (256 sessions, cancel_session) | yes | yes | yes | protocol flow live test passed |
| etcd 3.3 degraded mode | partial | partial | no | lease/history fallbacks coded; no retained 3.3 fixture |
| etcd 2.x | n/a | n/a | n/a | served by the dedicated `etcd2` agent, not this one |

## Known divergences

- None intentional. All observable protocol outputs are byte-for-byte
  compatible with the Java agent; the raw protobuf RPCs used for lease
  operations are an internal implementation change only.
