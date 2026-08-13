# DBX JDBC Plugin Prototype

This is an optional sidecar plugin for DBX. It is not bundled with the main DBX app.

## Build

```sh
./gradlew shadowJar
cp build/libs/dbx-jdbc-plugin-all.jar lib/dbx-jdbc-plugin.jar
```

## Package for release

```sh
./package.sh
```

The package version follows the JDBC plugin version in `build.gradle` and `manifest.json`.
The package script writes both `dbx-jdbc-plugin-<version>.zip` and `dbx-jdbc-plugin-latest.zip`.

## Install for local DBX

Copy this folder to the DBX app data plugin directory:

```text
<DBX app data>/plugins/jdbc
```

The folder must contain:

```text
manifest.json
bin/dbx-jdbc-plugin
lib/dbx-jdbc-plugin.jar
```

DBX does not bundle Java or JDBC drivers. Install Java locally and add database-specific driver JAR paths in the DBX JDBC connection form.

## MySQL-compatible cursor fetching

DBX uses standard JDBC result-set paging, but does not automatically set Connector/J's `useCursorFetch` property.
That property enables a MySQL-specific server cursor protocol; it is not part of JDBC and may be unsupported by
MySQL-compatible servers. If a server and driver are known to support it, opt in explicitly in the connection URL:

```text
jdbc:mysql://host:3306/database?useCursorFetch=true
```

Leave the property unset for generic JDBC or compatibility drivers that need to shield non-standard server behavior.

The first-class JDBCX profile uses `io.github.jdbcx.WrappedDriver` and
`jdbcx:[extension:][vendor://host:port/database]` URLs. Install a JDBCX Maven bundle such as
`io.github.jdbcx:jdbcx-driver:0.8.0` in the DBX JDBC driver store, together with the database vendor's JDBC driver.
JDBCX discovers delegate drivers through JDBC `ServiceLoader`/`Driver.acceptsURL`, without vendor-specific DBX code.
Each connection selects exactly one installed JDBCX runtime bundle; DBX excludes artifacts from every other installed
JDBCX version from that connection's classpath.

DBX restricts JDBCX to the `help`, `var`, and `version` extensions by default. Shell, Script, Web, MCP, and other
high-privilege extensions can execute local commands or access external resources, so they require an explicit
per-connection opt-in in the connection dialog.

Some high-privilege extensions require optional runtime libraries that JDBCX deliberately does not bundle. Install
those libraries in the JDBC driver store and select them for the same connection. For JDBCX 0.8.0, MCP requires
`io.github.jdbcx:io.modelcontextprotocol:1.0.1`; use the dependency version declared by the selected JDBCX release.
