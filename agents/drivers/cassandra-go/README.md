# Cassandra native Agent

The Cassandra Agent uses Apache `cassandra-gocql-driver` and implements the DBX
multi-session JSON-RPC protocol without a JVM.

## Compatibility

- Native protocol versions: v3-v5
- Declared server range: Apache Cassandra 2.1+
- Live validation: 2.2.19, 3.11.19, 4.1.10, and 5.0.6
- Kerberos live validation: Cassandra 4.1.10 with password, keytab, FILE ccache,
  JAAS discovery, and HOCON `configfile`
- Astra validation: secure-connect bundle parsing and transport configuration;
  live Astra credentials were not available
- Authentication: username/password and Kerberos/GSSAPI
- TLS: CA verification, optional client certificate/key, hostname verification
- Cloud: DataStax Astra secure connect bundles
- Configuration: Java Driver 4 HOCON `configfile` mapping plus native extensions
- Metadata: keyspaces, tables, columns, indexes, CQL table DDL, completion search
- Queries: legacy string result values, paging, cancellation, logged and unlogged batches

The Agent accepts both normal DBX connection fields and Cassandra JDBC-style
connection strings, including the wrapper's `host1--host2:9042` contact-point
syntax.

## JDBC URL parameter mapping

| JDBC parameter | Native behavior |
| --- | --- |
| `consistency` | GoCQL consistency |
| `fetchsize` | default page size |
| `retries` | retry/reconnection attempt count |
| `loadbalancing` | default, round-robin, DC-aware, or token-aware built-in policy |
| `localdatacenter` | DC-aware host selection |
| `retry` | default/simple, fallthrough, downgrading, or exponential built-in policy |
| `reconnection` | constant or exponential reconnection policy |
| `debug` | GoCQL debug logging to stderr |
| `enablessl` | TLS enablement |
| `sslenginefactory` | the standard `DefaultSslEngineFactory` maps to native TLS |
| `hostnameverification` | TLS hostname verification; enabled by default |
| `user`, `password` | password authentication |
| `configfile` | Java Driver 4 HOCON configuration; overrides URL options except contact points and keyspace |
| `usekrb5` | Kerberos/GSSAPI authentication using password, keytab, or FILE credential cache |
| `secureconnectbundle` | DataStax Astra secure connect bundle; contact points and manual TLS options are ignored |
| `requesttimeout`, `connecttimeout` | request and connection deadlines |
| `tcpnodelay`, `keepalive` | native TCP socket options |
| `compliancemode` | accepted; JDBC-only `java.sql` behavior is not applicable to JSON-RPC |

The Agent rejects custom Java implementation classes because they cannot be
loaded by a native binary. This includes custom authentication, SSL, retry,
reconnection, and load-balancing classes. Java JKS/PKCS12 truststores and
keystores are not read directly; use the native PEM paths described below.

## Java Driver HOCON configuration

`configfile` reads Java Driver 4 HOCON files and preserves the JDBC wrapper's
precedence: the file overrides URL options except contact points and keyspace.
A missing file is ignored for compatibility with the JDBC wrapper.

Mapped Java Driver paths include:

- `basic.request.timeout`, `consistency`, `serial-consistency`, and `page-size`
- `basic.load-balancing-policy.class` and `local-datacenter`
- `basic.cloud.secure-connect-bundle`
- `advanced.connection.connect-timeout` and `pool.local.size`
- `advanced.socket.tcp-no-delay` and `keep-alive`
- `advanced.protocol.version`, retry policy, and reconnection policy
- `advanced.auth-provider` plaintext and Instaclustr Kerberos options
- `advanced.ssl-engine-factory` default TLS and hostname validation

Native-only settings can be placed under `dbx.cassandra`:

```hocon
dbx.cassandra {
  tls {
    enabled = true
    ca-cert-path = "/path/to/ca.pem"
    client-cert-path = "/path/to/client.pem"
    client-key-path = "/path/to/client-key.pem"
    hostname-verification = true
  }
  kerberos {
    enabled = true
    config = "/etc/krb5.conf"
    jaas-config = "/path/to/jaas.conf"
    principal = "alice@EXAMPLE.COM"
    keytab = "/path/to/alice.keytab"
    service-name = "cassandra"
    server-name = "node1.example.com"
    authorization-id = "assumed_role"
    qop = "auth"
  }
}
```

## Kerberos

`usekrb5=true` implements the same GSSAPI flow used by the former Instaclustr
Java auth provider. The service principal defaults to
`cassandra/<canonical-node-hostname>`. Set `kerberosservername` when reverse DNS
does not resolve to the service-principal hostname.

Credential discovery order is:

1. Explicit JAAS `CassandraJavaClient` cache/keytab selection
2. Explicit `kerberosccache` or `kerberoskeytab`
3. Explicit principal and password
4. `KRB5CCNAME`, then `KRB5_CLIENT_KTNAME`/`KRB5_KTNAME`

The Agent also reads `java.security.auth.login.config` and
`java.security.krb5.conf` from `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, or
`JDK_JAVA_OPTIONS`. Only FILE credential caches are supported. SASL QOP `auth`
is supported; `auth-int` and `auth-conf` are rejected because they require
wrapping Cassandra traffic after authentication.

## Astra secure connect bundles

Set `secureconnectbundle` to a local Astra bundle ZIP and provide its database
credentials with `user` and `password`. A normal Cassandra host is not required.
Kerberos cannot be combined with a secure connect bundle. Manual TLS settings
are ignored because the bundle supplies its own CA, client certificate, key,
SNI endpoint, and metadata service.

## Integration test

```bash
CASSANDRA_TEST_HOST=127.0.0.1 \
CASSANDRA_TEST_PORT=9042 \
CASSANDRA_TEST_USERNAME=cassandra \
CASSANDRA_TEST_PASSWORD=cassandra \
go test -run TestCassandraIntegration -v
```

Optional variables include `CASSANDRA_TEST_URL_PARAMS`, `CASSANDRA_TEST_SSL`,
`CASSANDRA_TEST_CA_CERT_PATH`, `CASSANDRA_TEST_CLIENT_CERT_PATH`, and
`CASSANDRA_TEST_CLIENT_KEY_PATH`.

See `bench/README.md` for the archived JDBC comparison workflow and measured
Cassandra 4.1.10 results.
