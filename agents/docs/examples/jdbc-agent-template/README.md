# JDBC Agent Template

Copy this directory when adding a new JDBC-based DBX agent.

Recommended flow:

1. Rename `template` paths, package names, class names, and artifact names to the new agent name.
2. Replace the driver class and JDBC URL builder.
3. Implement metadata SQL using the target database system catalogs or `DatabaseMetaData`.
4. Keep `executeQuery` delegated to `JdbcExecutor`.
5. Place the module under `drivers/`, then add it to `settings.gradle`, `versions.json`, and the root README support table.
6. Run `./gradlew :<agent>:test :<agent>:shadowJar`.

To verify this template before copying it, run:

```bash
./gradlew -p docs/examples/jdbc-agent-template clean test shadowJar
```

See `docs/agent-authoring.md` for the full checklist.
