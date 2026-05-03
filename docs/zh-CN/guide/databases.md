# 数据库支持

DBX 通过 Rust 原生驱动支持 13+ 种数据库。

## 完整支持

| 数据库 | 驱动 | 协议 |
|---|---|---|
| MySQL | sqlx | MySQL |
| PostgreSQL | sqlx | PostgreSQL |
| SQLite | sqlx | 嵌入式 |
| Redis | redis-rs | RESP |
| MongoDB | mongodb | MongoDB Wire |
| DuckDB | duckdb-rs | 嵌入式 |
| ClickHouse | HTTP client | HTTP |
| SQL Server | tiberius | TDS |
| Oracle | oracle-rs | OCI |
| Elasticsearch | HTTP client | REST |

## MySQL 兼容

以下数据库使用 MySQL 协议，通过 MySQL 驱动连接：

| 数据库 | 默认端口 |
|---|---|
| MariaDB | 3306 |
| TiDB | 4000 |
| OceanBase | 2881 |
| GoldenDB | 3306 |
| Doris | 9030 |
| SelectDB | 9030 |
| StarRocks | 9030 |
| TDengine | 6030 |

## PostgreSQL 兼容

以下数据库使用 PostgreSQL 协议，通过 PostgreSQL 驱动连接：

| 数据库 | 默认端口 | 备注 |
|---|---|---|
| openGauss | 5432 | |
| GaussDB | 5432 | |
| KingBase（人大金仓） | 54321 | |
| Vastbase | 5432 | |
| Redshift | 5439 | |
| CockroachDB | 26257 | |
| DM（达梦） | 5236 | 需开启 PG 兼容模式 |

::: tip 达梦数据库说明
达梦数据库需要开启 PG 兼容模式。在 `dm.ini` 中设置 `COMPATIBLE_MODE=7` 并重启服务。
:::
