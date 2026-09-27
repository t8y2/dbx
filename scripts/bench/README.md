# Startup dependency benchmark

Run `pnpm bench:startup` from the repository root. The benchmark uses the current
production Vite configuration, checks generated connection descriptors, and builds
in memory without replacing `dist` or writing generated source files.

The JSON report lists cumulative static JavaScript dependencies for the entry,
startup gate, and main application, with English and Simplified Chinese variants.
Later phases include the earlier phases; do not add their byte counts together.
Gzip sizes are calculated per chunk, not measured HTTP transfer sizes. CSS, images,
runtime-selected backend transports, and other dynamic imports are not included.

The startup gate must not statically depend on the settings/connection/query stores
or the SQL editor. Check the `includes` fields to detect a broken lazy boundary.
Loading a previously saved SQL tab will still load its editor on demand.

Runtime phase markers are available through
`performance.getEntriesByType("mark").filter(entry => entry.name.startsWith("dbx:startup:"))`.
They distinguish gate mounting, locale/auth/migration completion, app mounting,
settings, connections, and restored tabs. App mounting is not editor interactivity;
the legacy `dbx:startup-ready` input-guard event is not a main-screen readiness metric.

Validate desktop and Web, returning users and first-run migration, login/setup,
slow or failed locale/module loading, optional AI failures, and restored/external
SQL tabs. Keep authentication before migration inspection, and editor settings
before connections before tab restoration. Bundle reductions are not cold-start
timing claims: native setup, storage, WebView parsing and rendering still need
separate measurement.
