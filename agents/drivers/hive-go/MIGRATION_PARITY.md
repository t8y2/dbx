# Hive JDBC to Go migration parity

Status date: 2026-08-11.

The migration is not complete until a capability is implemented, covered by
automated tests, validated against a real compatible server, and included in
the DBX native-agent build and release path. A unit test alone does not count as
production parity.

## Baseline

- DBX Java baseline: Apache Hive JDBC standalone 4.0.1.
- Compatibility reference: DBeaver keeps separate Hive 2 legacy and Hive 4+
  JDBC profiles. The Go migration must not infer Hive 2 support from Hive 3/4.
- DBX protocol baseline: the Go Agent implements the same stdin/stdout JSON-RPC
  methods used by the Java Agent.
- HS2 client protocol: Go requests `HIVE_CLI_SERVICE_PROTOCOL_V10`; Hive 3.1.3
  and Hive 4.2.0 accepted it in live validation.
- The current completion pass validates the Go Agent only. JDBC is retained as
  a historical behavior reference, not as a candidate in the secure discovery
  or Kerberos validation path.

## Current matrix

| Capability | Go code | Automated | Linux live | Windows live | Status |
| --- | --- | --- | --- | --- | --- |
| Hive 3.1.3 binary NOSASL | yes | yes | yes | n/a | parity smoke passed |
| Hive 4.2.0 binary NOSASL | yes | yes | yes | n/a | parity smoke passed |
| Spark 3.5.7 Thrift Server | yes | yes | yes | n/a | Go passed; Java requires a non-empty user in this fixture |
| Hive 2.x | probable protocol compatibility | partial | no | no | unsupported until a real Hive 2 server passes |
| Kyuubi | probable HS2 compatibility | partial | no | no | unsupported until a real Kyuubi server passes |
| Binary PLAIN (`NONE`) | yes | yes | yes | no | Java/Go parity passed on Hive 4.2.0 |
| Binary LDAP/CUSTOM PLAIN | yes | yes | no | no | needs a real authentication backend |
| Binary Kerberos `auth` | yes | yes | yes | no | Go keytab login, query, metadata, and clean shutdown passed on Hive 4.2.0 |
| Binary Kerberos `auth-int` | yes | yes | yes | no | Go integrity-protected query passed on Hive 4.2.0 |
| Binary Kerberos `auth-conf` | yes | yes | yes | no | Go confidentiality-protected query passed on Hive 4.2.0 |
| HTTP PLAIN/Basic | yes | yes | yes | no | Java/Go parity passed on Hive 4.2.0 |
| HTTP NOSASL | yes | yes | no | no | needs a real HS2 HTTP fixture |
| HTTP LDAP/CUSTOM | yes | yes | no | no | needs a real authentication backend |
| HTTP Kerberos/SPNEGO | yes | yes | no | no | needs KDC + HS2 validation |
| HTTP Kerberos TLS channel binding | yes | yes | no | no | needs TLS + KDC validation |
| HTTP JWT bearer | yes | yes | no | no | header and cookie retry behavior are covered; real HS2 JWT validation is pending |
| HTTP browser SSO | yes | yes | no | no | pre-issued token and interactive 302/browser/loopback callback flow are implemented; real IdP validation is pending |
| HTTP delegation-token header | yes | yes | no | no | `X-Hive-Delegation-Token` behavior is covered; real HS2 token validation is pending |
| HTTP cookie auth, XSRF/CSRF, and request tracking | yes | yes | partial | no | Java-compatible headers, static/server cookies, 401 credential retry, and `X-Request-ID` are covered; the retained HTTP fixture failed to restart because of its stale PID state |
| One-way TLS | yes | yes | no | no | PEM/JKS/PKCS12 parsing is tested; handshake is not |
| Mutual TLS | yes | yes | no | no | PEM/JKS/PKCS12 parsing is tested; handshake is not |
| Binary delegation token (`DIGEST-MD5`) | yes | yes | no | no | token decoding is tested; HS2 exchange is not |
| ZooKeeper service discovery | yes | yes | yes | no | two-node discovery and reconnect failover passed |
| ZooKeeper stale-node handling | yes | yes | yes | no | Java/Go both passed 12 sequential connects with one stale node |
| ZooKeeper digest ACL | yes | yes | no | no | needs a secured ZooKeeper fixture |
| ZooKeeper TLS | yes | yes | no | no | trust/key store parsing is tested; handshake is not |
| ZooKeeper Kerberos SASL | yes | MiniKDC protocol test | yes | no | required-SASL ZooKeeper discovery into Kerberos HS2 passed |
| ZooKeeper active/passive HA mode | yes | yes | no | no | needs an active/passive HS2 fixture |
| Windows Kerberos SSPI | yes | Windows x64 cross-build | n/a | no | PE32+ amd64 build passed; Windows domain live validation is still required |
| Keytab Kerberos | yes | yes | yes | no | MiniKDC + Hive 4.2.0 live validation passed |
| Ccache and password Kerberos | yes | yes | no | no | credential-source parsing is tested; real HS2 login is pending |
| JDBC URL session/hiveConf/hiveVar sections | yes | yes | yes | no | Hive 4.2.0 session values passed |
| Proxy user and compatibility session variables | yes | yes | partial | no | parsing/open-session mapping passed |
| Query values and column type semantics | yes | yes | yes | no | Hive 4.2.0 type matrix matches Java except improved binary hex output |
| Metadata databases/tables/columns/DDL | yes | yes | partial | no | database/table smoke and `visible_schemas` filtering passed; full metadata matrix pending |
| Paged reads | yes | yes | yes | no | Hive 3.1.3 and 4.2.0 parity passed |
| Failed SQL is not replayed | yes | yes | yes | no | failed statement followed by successful query passed |
| Cancellation and timeout | yes | yes | no | no | real long-running query validation pending |
| Large result and large complex values | yes | yes | partial | no | functional samples passed; boundary fixture pending |
| JDBC client compatibility properties | yes | yes | partial | no | fetch/message sizing, retries, init file, application name, HTTP headers/cookies, request tracking, and browser settings are mapped |
| Native DBX install/launch | yes | yes | local artifact smoke | no | DBX tests prove native launch without a JRE and replacement of a stale Hive `agent.jar`; packaged desktop upgrade remains pending |
| Native CI/release artifacts | yes | yes | local build | cross-build | Hive version bumping, registry packaging, release notes, CI tests, and six native targets are wired |

## JDBC 4.0.1 client feature coverage

The native Agent now maps these Hive JDBC 4.0.1 client behaviors:

- JWT bearer authentication and delegation-token HTTP headers.
- Browser SSO with either a pre-issued bearer token or the JDBC-compatible
  interactive 302 redirect, local callback listener, browser launch, token, and
  client-identifier retry flow.
- Configurable cookie authentication and cookie name, including 401 retry and
  static `http.cookie.*` authentication cookies.
- `http.header.*`, `http.cookie.*`, the JDBC XSRF/CSRF headers, and
  `requestTrack` / `X-Request-ID`.
- `retries`, `retryInterval`, `initFile`, connection-level `fetchSize`,
  `socketTimeout`, and `thrift.client.max.message.size`.
- `applicationName` / `ApplicationName`, `wmPool`, proxy user, session variables,
  HiveConf, and HiveVar OpenSession mappings.
- Browser response port/timeout and the JDBC browser SSL requirement override.

Java `kerberosAuthType=fromSubject` has no literal Go `Subject` object. Its
native equivalent is the connection-scoped credential abstraction: Windows
SSPI on Windows and the default credential cache on Unix, with explicit ccache,
keytab, or password sources still supported.

One Java-specific secret source remains intentionally non-silent:
`storePasswordPath` points at a Hadoop credential-provider/JCEKS store. The Go
Agent rejects this case unless `trustStorePassword` / `keyStorePassword` is
provided explicitly; it does not pretend that the Java credential provider was
read successfully.

The remaining migration work is therefore live compatibility validation and
native DBX delivery verification, not another Java implementation.

## Live evidence

The Linux x86-64 Go binary used for the secure Kerberos validation has SHA-256:

```text
c41cb7c1192748d70dfaf575123059f78a42d1f1fd0b1d6952769ccd3dcab8d6
```

The previous Linux x86-64 native artifact after the HTTP, Browser SSO,
init-file, and release-path completion pass had SHA-256:

```text
2053c4d127a2bb3fd67eb31b995998cce749b7adec7b13548e768f53435a2850
```

The current Linux x86-64 native artifact after the DBX visible-schema and
native-upgrade completion pass has SHA-256:

```text
ea1924508688fc5f9ab3abab914fc0cc9a0a8c811bbfd95a14a4c57a82f4696d
```

Validation result SHA-256 values:

```text
707846a387abce3b3a4f282e22afcb514f5e2760eee04f2a2f7f822740acc9fe  functional Hive 3.1.3 / 4.2.0 / Spark smoke
8774dbbda55a5fc0aada1862659da29fcd0be2a1e7d88c28196981a7e6913479  Hive 4.2.0 Binary PLAIN
8774dbbda55a5fc0aada1862659da29fcd0be2a1e7d88c28196981a7e6913479  Hive 4.2.0 HTTP PLAIN/Basic
3d1d2d8278b3c792d0ac8c109a2de59cda86cb0a329fb9f74e87d62603b7af60  ZooKeeper two-node reconnect failover
8e97211cf9f4c1b95feb1c498230fe725b4e5e2b01c068ef0cb59ced11adb7d6  ZooKeeper stale-node handling
521137fdc96a04462956f01d6e83806122736f5da1da49d4a2dbb8d80a397d72  Hive 4.2.0 Binary Kerberos auth
bc16ca7661072a83e3bf1066e8a9db1de58c62a4dea6caca88baccdb5dd89219  Hive 4.2.0 Binary Kerberos auth-int
8309580d892b2e92e79122b590d4e3a1811e513c821ff02e5f386304ff1e6c3f  Hive 4.2.0 Binary Kerberos auth-conf
f1bc8ac45e523cf21873f89343912f791d144e680c4832132fa4f419d7e32838  Kerberos ZooKeeper discovery into Kerberos Hive 4.2.0
d81b3506acace2b16270d7ee806de6f5b165cfcae4aea17bddbcb57fb67a021e  final native artifact against ZooKeeper-discovered Hive 4.2.0
6ea6919c3239f4c5b0486429ab27cbd64f60a4d9e2c2fcd2df8d4ca161c2c186  current native artifact against ZooKeeper-discovered Hive 4.2.0
fcd9069d1a6dfaeee3a478a3187a8a63f5e699175fc03f90edeb543274fc5e97  current visible-schema live validation
```

The two PLAIN result files intentionally have the same hash because they record
the same logical Java/Go result through different transports.

## Next gates

1. HTTP JWT, delegation-token, Browser SSO/IdP, Kerberos, and TLS channel-binding live validation.
2. One-way TLS and mutual-TLS handshakes.
3. ZooKeeper digest ACL, TLS, and active/passive HA.
4. Cancellation, timeout, and large-result live semantics.
5. Kyuubi and a real Hive 2.x deployment.
6. Windows x64 SSPI validation with the same KDC/HS2 fixture.
7. Packaged desktop install/launch and an actual user-data upgrade from the
   previous Java artifact; automated core tests already cover native selection
   and stale `agent.jar` replacement.
