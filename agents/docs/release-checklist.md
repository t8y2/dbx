# Release Checklist

Use this checklist before pushing release tags or publishing DBX agent jars.

## 1. Confirm Scope

- Review the recent commits:

```bash
git log --oneline -10
```

- Confirm the working tree is clean before tagging:

```bash
git status --short
```

- Check that each intended agent change touches the right module directory, `common`, `test-support`, docs, or workflows.
- Avoid mixing unrelated driver updates, behavior changes, and release-only edits in the same commit.

## 2. Local Verification

On this workspace, use the local JDKs under `/private/tmp`:

```bash
env JAVA_HOME=/private/tmp/dbx-jdk/jdk-21.0.11+10/Contents/Home \
  ./gradlew \
  -Dorg.gradle.java.installations.paths=/private/tmp/dbx-jdk/jdk-21.0.11+10/Contents/Home,/private/tmp/dbx-jdk8/jdk8/Contents/Home \
  test shadowJar --continue
```

Also run the lightweight validation gates:

```bash
python3 -m unittest discover -s scripts -p '*_test.py'
python3 scripts/validate_agents.py
python3 scripts/validate_agent_jars.py
git diff --check
```

Expected result:

- Python script tests pass.
- `Agent validation passed`.
- `Agent jar validation passed` after `shadowJar` has produced jars.
- `git diff --check` prints nothing.
- Gradle finishes with `BUILD SUCCESSFUL`.

## 3. Agent Contract Checks

For changed agent modules:

- `executeQuery` delegates to `JdbcExecutor.execute`.
- No module-local SQL prefix classifier is present.
- No module-local result row cap is present.
- `Statement.execute(...)` is used for arbitrary user SQL.
- Metadata methods return stable ordering for schemas, tables, columns, indexes, foreign keys, and triggers.
- User-controlled schema and table names are passed through prepared statements or quoted with `JdbcIdentifiers`.
- `connect` stores one connection, `disconnect` closes and clears it, and `testConnection` closes its temporary connection.
- A behavior test exists:
  - Use `JdbcExecutionBehaviorTest` and `JdbcMetadataBehaviorTest` for agents with a local/embedded test database.
  - Use `JdbcFakeExecutionBehaviorTest` for agents that require unavailable external drivers.
  - Use targeted `JdbcMetadataSqlFake` tests for metadata SQL that must interpolate quoted identifiers.

## 4. Registry And Module Checks

Run:

```bash
python3 scripts/validate_agents.py
```

This checks:

- `versions.json` keys match included agent modules in `settings.gradle`.
- Root Gradle conventions define agent archive names.
- Agent manifests define `Agent-Label`.
- Agent manifests define `Main-Class`.
- Agent `Main-Class` source exists and the built jar contains the matching `.class`.
- Forbidden legacy execution patterns are absent.
- Disallowed JVM source/build DSL residue is absent outside Gradle output directories.

When adding or removing an agent, update these files together:

- `settings.gradle`
- `versions.json`
- `README.md`
- Agent module `build.gradle` for driver dependencies and manifest attributes
- Root `build.gradle` only when the module needs non-standard shared build behavior

## 5. Driver Packaging

For bundled drivers:

- Verify the dependency is redistributable.
- Prefer Maven dependencies over checked-in jars.

For external drivers:

- Use `implementation fileTree(dir: 'libs', include: ['*.jar'])`.
- Set the manifest attribute:

```groovy
attributes(
    'Agent-External-Driver': 'true'
)
```

- Confirm release registry generation emits `external_driver_required: true`.

Current external-driver agents include BigQuery and SunDB.

## 6. JRE Selection

Java agents are built for the default JRE key `21`, backed by JDK 21 in the release workflow. Native agents do not require a JRE.

If another agent needs a different runtime, update the release workflow JRE detection logic.
- Document why in the module or release notes.
- Verify DBX can download the matching runtime artifact.

## 7. CI Expectations

The CI workflow runs on `main` and pull requests:

```bash
python3 -m unittest discover -s scripts -p '*_test.py'
python3 scripts/validate_agents.py
./gradlew test shadowJar --continue
python3 scripts/validate_agent_jars.py
```

Do not tag a release while CI is failing on `main`.

## 8. Release Tag Flow

Release workflow runs on tags matching `agents-v*`.

Before tagging:

```bash
git status --short
git log --oneline -5
git tag --list 'agents-v*' --sort=-creatordate | head
```

Choose a new tag that does not already exist locally or on GitHub. For example:

```bash
RELEASE_TAG=agents-v0.3.0
git tag --list "$RELEASE_TAG"
git ls-remote --tags origin "$RELEASE_TAG"
```

Both commands should print nothing before you create the tag.

Create and push the tag:

```bash
git tag "$RELEASE_TAG"
git push origin main
git push origin "$RELEASE_TAG"
```

The release workflow will:

- Bump changed module versions in `versions.json`.
- Build all agent shadow jars.
- Build/download JRE artifacts.
- Generate `agent-registry.json`.
- Create a GitHub release with jars, JRE archives, and registry.

## 9. Post-Release Verification

After the GitHub release finishes:

- Download or inspect `agent-registry.json`.
- Confirm every expected agent appears under `drivers`.
- Confirm labels preserve spaces, for example `Google BigQuery`.
- Confirm Java agents use JRE key `21`.
- Confirm `external_driver_required` is correct.
- Confirm every jar URL, sha256, and size is present.
- Spot-check at least one agent jar manifest:

```bash
unzip -p dbx-agent-h2.jar META-INF/MANIFEST.MF
```

## 10. Known Follow-Ups

- Gradle currently reports deprecated features that will be incompatible with Gradle 10. Use `--warning-mode all` in a separate cleanup task.
- Commercial or external-driver agents still need manual smoke tests with real driver jars and databases.
- Add real containerized smoke tests only one database family at a time.
