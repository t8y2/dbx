# Plugins

DBX declarative extension metadata and runtime plugins live here.

Plugins are not Node packages, so they intentionally stay separate from `packages/`.

## Directories

- `connection-types/` - build-time registry for every DBX connection target, including databases, data services, message queues, and service registries.
- `dialects/` - SQL dialect descriptors, type catalogs, DDL templates, and metadata rules.
- `mappings/` - cross-dialect type mapping rules.
- `jdbc/` - optional Java/JDBC plugin for connecting through vendor JDBC drivers and custom JDBC URLs.

Plugin build artifacts, downloaded driver JARs, and local targets are ignored by Git.
