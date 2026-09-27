# CI job boundaries

Paths in this guide are relative to `.github/`.

`workflows/ci.yml` retains one workflow and one cancellation group. Splitting jobs
does not change release workflows or branch-protection settings. The existing
`rust` and `agents` aggregate check names remain; `ci` additionally summarizes all
selected jobs. None of these gates accepts a failed, cancelled, missing, or
unexpectedly skipped prerequisite.

## Selection

`scripts/ci-plan.mjs` reads Cargo workspace metadata and the exact event base/head
diff. Renames include both paths and deleted paths remain visible. Rust package
selection follows reverse dependencies, including build and test dependencies.
Connection-type descriptors belong to `dbx-types`; dialect descriptors belong to
`dbx-sql`. A changed core dependency also selects the standalone DuckDB Agent tests,
whose development dependency is `dbx-core`.

- Ordinary Rust PRs select foundation, driver, and application test groups from
  `scripts/ci-config.mjs`. Each group contains several packages, not one runner per
  crate. At most three Rust test groups run concurrently.
- Main pushes, shared Cargo manifests/locks, toolchain/config/vendor changes, CI
  infrastructure changes, an unknown workspace member, or an unavailable diff
  select the original full-workspace test lane instead of duplicating it with all
  three groups.
- Strict clippy still checks the complete workspace and all targets. The existing
  full/fast feature distinction is retained: fast skips system-font discovery,
  not the other previously enabled capabilities.
- Native Agent source changes select the affected native driver and its live
  cases. Shared Agent inputs conservatively select all existing Agent checks.
  Windows DuckDB packaging is selected by its own inputs or shared build/lock
  changes, not every change to its development dependency's source.
- Existing frontend, package, Windows, JDBC, offline-payload and Nix jobs retain
  their commands and path filters.

Changes to the planner itself select the broad checks. Missing/invalid planning
data fails the aggregate gates rather than producing a successful skip.

## Fast checks and Rust feature coverage

`fast-checks` runs formatting and CI/architecture contracts before dependency
resolution or compilation. It checks generated connection types without rewriting
them and validates the relevant root and independent Agent Cargo lockfiles with
full `cargo metadata --locked`; `--no-deps` is intentionally not used for that
validation.

Cargo may unify features supplied by different workspace consumers. Grouped tests
therefore explicitly retain the features previously enabled on each package,
including plugin runtime defaults and the driver's bundled SQLite capability.
`scripts/ci-rust-coverage.mjs` compares each selected workspace package's enabled
features with the full-workspace invocation and verifies that the groups cover
every workspace member exactly once. It fails if a selected package loses a
feature. An unassigned new workspace member forces the full-workspace lane and
bypasses only the group-specific audit until it is assigned a group. This does not substitute for
the full-workspace integration lane, and does not use `--all-features` to combine
incompatible SQLite backends.

## Agent jobs

| Job | Coverage | Maximum parallelism |
| --- | --- | --- |
| `agent-checks` | Existing Python/script tests and Agent source validation | 1 |
| `agent-java` | Existing Java tests, `shadowJar`, and JAR validation | 1 |
| `agent-rust` | DuckDB and TDengine tests; TDengine release build | 2 |
| `agent-go` | Ten existing native Go test/build targets, original race flags, six ZooKeeper cross-build targets | 4 |
| `agent-integration` | Sixteen existing engine/version/authentication cases | 4 |

Matrix jobs set `fail-fast: false`, so one failure does not conceal results from
the other selected cases. Live test predicates, readiness checks, time limits,
credentials for disposable fixtures, and failure cleanup are retained.
Native, Java and live jobs wait for fast checks and Agent source validation before
starting expensive builds or containers.
RocketMQ's existing integration harness starts official server JARs through Maven
and Java rather than Docker; those matrix entries explicitly retain Java 21.

| Integration scenario | Versions |
| --- | --- |
| ZooKeeper | 3.4.14, 3.5.5, 3.7.0, 3.9.5; large-child-list coverage remains on 3.7.0 |
| ZooKeeper SASL DIGEST-MD5 | 3.7.0 |
| RocketMQ | 4.9.8, 5.3.1 |
| TDengine | 2.4.0.14, 2.6.0.34, 3.0.7.1, 3.3.6.13, 3.4.2.2; the last uses `tdengine/tsdb` |
| Cassandra | 3.11.19, 5.0.6 |
| RabbitMQ | 3.13, 4.3 |

## Validation

Run these from the repository root:

```sh
node --test .github/scripts/ci-*.test.mjs
node .github/scripts/ci-rust-coverage.mjs
actionlint .github/workflows/ci.yml
bash -n .github/scripts/ci-agent-go.sh
bash -n .github/scripts/ci-agent-integration.sh
```

The shell-command tests replace Docker, compilers, readiness probes and delegated
integration scripts with recording stubs. They verify all configured cases and
failure propagation without starting an engine; they are not live database tests.
Do not run the integration shell script on a developer machine. It targets
disposable Actions runners; equivalent validation on the designated test server
must follow that server's isolated-container naming and port policies.

The split aims to isolate failures, return small-check results earlier, and remove
unrelated work. Rust groups can still repeat dependency compilation across runners;
compare cold/warm build, link, test and queue time on actual runs before claiming a
speedup or changing group sizes. Cancelled runs are not successful benchmarks.
