# Neo4j native Agent

This module replaces the Neo4j JDBC Agent with the official Neo4j Go Driver.

## Runtime model

- One Neo4j `Driver` connection pool is shared by DBX Agent sessions with the same connection identity.
- Each DBX Agent session is serialized independently, while different sessions can execute concurrently.
- Query and table-read paging keep the Neo4j session and result cursor open until the cursor is exhausted, closed, or cancelled.
- The driver uses a 1 MiB network read buffer. Bounded non-paged queries with an explicit numeric `LIMIT` can use `FetchAll`; unbounded queries keep batched fetching to bound memory use.
- The default Go scheduler parallelism is capped at four OS threads on high-core hosts. Set `GOMAXPROCS` or `DBX_AGENT_NEO4J_GOMAXPROCS` to override it.

## Compatibility

- `neo4j://` (routing) is the default scheme. When a server reports that cluster
  routing is unavailable — Bolt 3 servers such as Neo4j 3.5, which never expose
  the routing procedure — the agent retries the same target with a direct
  `bolt://` connection. An explicit `scheme` parameter still wins, including the
  TLS variants (`bolt+s` / `bolt+ssc`).
- Servers that negotiate Bolt 3 or older only expose the default database, so
  the agent does not send a database name for them (the driver rejects it).
- Neo4j databases are discovered with `SHOW DATABASES`, with the configured database retained as a fallback for Community-compatible servers such as Memgraph.
- Node labels use `CALL db.labels()`.
- Properties use `db.schema.nodeTypeProperties()` with a sampled-node fallback.
- Index uniqueness is derived from `SHOW INDEXES ... owningConstraint`, which is compatible with Neo4j 5.x.
- Scalar query values remain displayable strings and null remains null. Graph values carry a versioned envelope with the original display text, typed identities and properties for the shared graph result view.

## Validation

```bash
go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" .
```

Run the optional live test against a real server:

```bash
DBX_NEO4J_LIVE=1 \
DBX_NEO4J_HOST=127.0.0.1 \
DBX_NEO4J_USER=neo4j \
DBX_NEO4J_PASSWORD=password \
go test -run TestLiveNeo4jAgent
```

`TestLiveNeo4jAgentSingleInstanceRoutingFallback` uses the default routing
scheme on purpose, so it exercises the direct-connection fallback; run it
against a single-instance server that cannot route (for example Neo4j 3.5).
