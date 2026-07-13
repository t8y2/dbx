# DBX JDBC Plugin Prototype

This is an optional sidecar plugin for DBX. It is not bundled with the main DBX app.

## Build

```sh
mvn -q -DskipTests package
mkdir -p lib
cp target/dbx-jdbc-plugin-*-all.jar lib/dbx-jdbc-plugin.jar
```

## Package for release

```sh
./package.sh
```

The package version follows the JDBC plugin version in `pom.xml` and `manifest.json`.
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

The first-class JDBCX profile uses `io.github.jdbcx.WrappedDriver` and
`jdbcx:[extension:][vendor://host:port/database]` URLs. Install a JDBCX Maven bundle such as
`io.github.jdbcx:jdbcx-driver:0.8.0` in the DBX JDBC driver store, together with the database vendor's JDBC driver.
JDBCX discovers delegate drivers through JDBC `ServiceLoader`/`Driver.acceptsURL`, without vendor-specific DBX code.
