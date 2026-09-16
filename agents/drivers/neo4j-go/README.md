# Neo4j native Agent

This module replaces the Neo4j JDBC Agent with the official Neo4j Go Driver.

## Runtime model

- One Neo4j `Driver` connection pool is shared by DBX Agent sessions with the same connection identity.
- Each DBX Agent session is serialized independently, while different sessions can execute concurrently.
- Query and table-read paging keep the Neo4j session and result cursor open until the cursor is exhausted, closed, or cancelled.
- The driver uses a 1 MiB network read buffer. Bounded non-paged queries with an explicit numeric `LIMIT` can use `FetchAll`; unbounded queries keep batched fetching to bound memory use.
- The default Go scheduler parallelism is capped at four OS threads on high-core hosts. Set `GOMAXPROCS` or `DBX_AGENT_NEO4J_GOMAXPROCS` to override it.

## Compatibility

- Neo4j databases are discovered with `SHOW DATABASES`, with the configured database retained as a fallback for Community-compatible servers such as Memgraph.
- Node labels use `CALL db.labels()`.
- Properties use `db.schema.nodeTypeProperties()` with a sampled-node fallback.
- Index uniqueness is derived from `SHOW INDEXES ... owningConstraint`, which is compatible with Neo4j 5.x.
- Query row values retain the previous Agent behavior: scalar and graph values are returned as displayable strings, while null remains null.

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
