# Startup dependency benchmark

## SQL editor typing

Run `node scripts/bench/editor-typing.mjs`, open the printed local URL, and click
Run benchmark. It mounts the real QueryEditor with its feature extensions enabled
and runs the actual completion and diagnostic Web Workers alongside typing.
It covers 5,000 and 20,000 statements and edits inside a single 5,000-line INSERT.
The JSON report distinguishes synchronous input-dispatch time from animation-frame
gaps, including delayed analysis after typing. This is an offline browser benchmark:
it does not measure database metadata latency or the native desktop WebView.

## SQL editor large-content scenarios

Run `node scripts/bench/editor-scenarios.mjs [scenario ...]` (scenarios live in
`editor-scenarios.definitions.mjs`: 100k/10k data lines, a 1.5 MB single line, a
300-line stored procedure, 300 MyBatis-style lines, five 200-line tabs). It starts the
Vite server, drives headless Chrome (override with `CHROME_PATH`) over CDP, and for each
phase (mount, typing at the end and in the middle, select all, drag selection, scroll)
prints the page timings plus the top self-time functions from a CPU profile
(`TOP=<n>`, `NO_PROFILE=1` to skip). Chrome has no macOS text-services selection cost, so
selection results here say nothing about WKWebView; use a WebKit build for that.

## Startup dependencies

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
