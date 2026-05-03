# Database Support

DBX supports 13+ database engines through native Rust drivers.

## Fully Supported

| Database | Driver | Protocol |
|---|---|---|
| MySQL | sqlx | MySQL |
| PostgreSQL | sqlx | PostgreSQL |
| SQLite | sqlx | Embedded |
| Redis | redis-rs | RESP |
| MongoDB | mongodb | MongoDB Wire |
| DuckDB | duckdb-rs | Embedded |
| ClickHouse | HTTP client | HTTP |
| SQL Server | tiberius | TDS |
| Oracle | oracle-rs | OCI |
| Elasticsearch | HTTP client | REST |

## MySQL Compatible

These databases use MySQL protocol and work with the MySQL driver:

| Database | Default Port |
|---|---|
| MariaDB | 3306 |
| TiDB | 4000 |
| OceanBase | 2881 |
| GoldenDB | 3306 |
| Doris | 9030 |
| SelectDB | 9030 |
| StarRocks | 9030 |
| TDengine | 6030 |

## PostgreSQL Compatible

These databases use PostgreSQL protocol and work with the PostgreSQL driver:

| Database | Default Port | Notes |
|---|---|---|
| openGauss | 5432 | |
| GaussDB | 5432 | |
| KingBase | 54321 | |
| Vastbase | 5432 | |
| Redshift | 5439 | |
| CockroachDB | 26257 | |
| DM (Dameng) | 5236 | Requires PG compatibility mode |

::: tip DM (Dameng) Note
DM database requires PG compatibility mode to be enabled. Set `COMPATIBLE_MODE=7` in `dm.ini` and restart the service.
:::
