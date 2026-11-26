# Sidebar connection marks

Connection-tree badges are resolved through `connectionBadge.ts` and rendered in white by `ConnectionBadgeIcon.vue` with a CSS mask. The shared original-artwork index (`databaseIconAssets.ts`) currently contains 127 database/provider aliases representing 97 distinct assets. All native entries and profiles in the 88-entry driver manifest are covered; plugin connections retain their plugin icon behavior. Connected tile colors are DBX presentation choices. With the optional Color-coded badges style, every native disconnected connection uses the same neutral gray (`#737373`) with the same white mark.

## Previously selected presentation

| Database | Connected tile | Treatment |
| --- | --- | --- |
| MySQL | `#28d43b` | Fuller revision of user-selected proposal B; green selected by the user |
| Redis | `#983d48` | Official R motif, burgundy tile; mark has 20% inset as in the selected alternate preview |
| Oracle | `#ff003b` | Ring mark |
| SQL Server | `#ffa600` | Mesh mark |
| PostgreSQL | `#3d6087` | Filled white elephant on blue-gray |
| SQLite | `#24566b` | Feather on dark blue |
| MariaDB | `#6b617c` | Historical seal motif on gray-purple |
| MongoDB | `#286746` | Leaf on forest green, transparent vein |
| Snowflake | `#287f9e` | White snowflake on lake blue |

Colored badges and connection group folders use 16px icon slots in both standard and compact modes. Background colors represent connection state independently of row selection. Database/provider aliases retain the same presentation, including PostgreSQL, SQLite Worker, MongoDB Legacy, Oracle Legacy/10g/OCI and SQL Server Legacy. Plugin connections continue to use their plugin logos. All native connection rows in colored badge mode, including basic adaptations and unknown types, use the same 16px slot. Types without a dedicated variant use their registered full-color artwork as a white mask. Types without a registered asset use a white generic database glyph on a blue tile when connected and a gray tile when disconnected. Legacy badges are the default and preserve the original 14px rendering and disconnected treatment.

## Extended coverage

- 39 distinct assets have an individual monochrome presentation, including the previously approved nine and ClickHouse, DuckDB, Elasticsearch, DynamoDB, TiDB, OceanBase, openGauss, GaussDB, Doris, StarRocks, DB2, H2, Neo4j, BigQuery, Cassandra, Redshift, Databricks, Hive, Trino, InfluxDB, CockroachDB, Qdrant, Meilisearch, CouchDB, Kafka, Pulsar, Spanner, TDengine and Dameng.
- 58 other distinct assets use basic adaptation: retain the original SVG/PNG/WebP silhouette as an alpha mask, add a theme-colored rounded tile, and switch only the tile to gray when disconnected. This keeps all supported native types consistent without redrawing vendor artwork.
- Eight basic assets need small exceptions: Access, HighGo, Nebula, Vertica and GBase use self-contained inverse-luminance SVG wrappers around their original bitmap to preserve inner detail and remove opaque light panels; RabbitMQ and RocketMQ keep original foreground geometry while removing their circular backplates; ChromaDB retains its overlapping internal shape as transparent detail. These are still basic adaptations.
- The nine approved palettes remain explicit. Additional connected colors are presentation choices; fallback colors in `databaseIconColors.ts` are derived from the existing source artwork and darkened for white-mark contrast. They are not official brand palette declarations.

The additional vector files retain geometry from the same-named asset in the parent directory. DynamoDB, H2 and DB2 extract their foreground glyph from the original colored panel. DuckDB keeps the original duck glyph rather than its circular backdrop. Neo4j retains both the original n-shaped body and connected graph mark, and centers the complete emblem; the light-colored n is part of the logo, not a removable background. Cassandra and Hive preserve interior detail through luminance masks. Redshift keeps transparent seams between the original planes. No screenshot artwork is traced.

`DatabaseIcon.vue` and the connection tree share one original-asset mapping so aliases and provider profiles cannot drift between surfaces. General database icons retain their original full-color rendering and existing theme treatment. Sidebar-only masking does not alter the original files.

## Asset sources and adjustments

- `mysql.svg`: custom solid dolphin drawn by GPT-6 Astra with medium reasoning for this UI. The user selected proposal B, then requested a fuller body: the back expands outward, the abdomen drops into a wider continuous curve, the pectoral-fin cutout becomes shallower, and the tail peduncle is thicker. The original B snout, transparent eye and connected two-leaf tail are retained. All cubic curves were redrawn; the reference app's exact silhouette is not traced. The eye is transparent through an evenodd subpath. This is a small-size DBX adaptation of the recognizable dolphin motif, not an unmodified official SVG. Identity reference: [MySQL logo downloads](https://www.mysql.com/about/legal/logos.html).
- `redis.svg`: Redis R mark from [Simple Icons](https://github.com/simple-icons/simple-icons/blob/develop/icons/redis.svg), distributed under [CC0-1.0](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md). The [Redis brand guidelines](https://redis.io/wp-content/uploads/2024/09/Redis_BrandGuidelines_Partners_Vol01_20240903_SM.pdf) identify the R mark. The user selected the alternate official-R presentation, replacing the historical stack exploration. Burgundy color and increased clear space distinguish this UI treatment from the reference app.
- `oracle.svg`, `sqlserver.svg`: monochrome derivatives of the existing database assets in the parent directory. Oracle's viewBox is cropped to normalize its visual size.
- `postgres.svg`: filled white adaptation of the existing solid elephant paths in `../postgres.svg`, with original path geometry and facial cutouts retained and the viewBox centered. Replaces the previous thin white outline. [Official logo identity reference](https://wiki.postgresql.org/wiki/Logo).
- `sqlite.svg`: original feather path from `../sqlite.svg`, page background removed and viewBox cropped. Identity reference: [SQLite official banner](https://sqlite.org/images/sqlite370_banner.svg).
- `mariadb.svg`: monochrome version of the existing seal mark; Foundation / historical identity, not claimed to be the latest enterprise logo. [MariaDB Foundation](https://mariadb.org/about/).
- `mongodb.svg`: solid leaf adapted from the original mark, with a broader silhouette and a transparent vein cut directly into the path. [MongoDB brand resources](https://www.mongodb.com/company/newsroom/brand-resources).
- `clickhouse.svg`: straight bars and a separate dot based on the original mark, with spacing adjusted for the sidebar.
- `snowflake.svg`: monochrome version of the existing snowflake mark, viewBox cropped to normalize visual size. [Snowflake brand guidelines](https://www.snowflake.com/brand-guidelines/).

For existing assets, an official identity reference establishes the motif, not the exact provenance of the repository path data. Reference app screenshots inform dimensions and interaction; they are not vector or bitmap asset sources. Never trace a reference app's custom mark one-for-one.

The original full-color database assets remain available to other app surfaces. Keep mark backgrounds transparent and preserve internal cutouts when adding variants. Run `connectionBadge.spec.ts` after changing the registry: it validates all native driver/profile paths, original assets, profile precedence, aliases, and fallback sizing against the owning driver manifest.
