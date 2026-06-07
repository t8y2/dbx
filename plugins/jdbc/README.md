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
