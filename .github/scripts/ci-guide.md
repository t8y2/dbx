# CI job boundaries

Paths in this guide are relative to `.github/`.

`workflows/ci.yml` retains one workflow. Splitting jobs does not change release
workflows or branch-protection settings. The existing
`rust` and `agents` aggregate check names remain; `ci` additionally summarizes all
selected jobs. None of these gates accepts a failed, cancelled, missing, or
unexpectedly skipped prerequisite. The gates are guarded by
`if: always() && !cancelled()`: on a cancelled run, `always()` alone would still
execute the gate and report cancelled prerequisites as a failure.

## Contributor concurrency

PRs from anyone other than the repository owner share a main `CI` concurrency
group keyed by the PR author's stable numeric user ID. Only one run in that
author's group executes at a time; other authors have independent groups.
The PR author, not the trigger actor or author association, determines this
policy, so a maintainer retrigger cannot bypass contributor limits.
`cancel-in-progress: false` preserves the executing PR, and `queue: max` retains
up to 100 pending runs rather than replacing earlier pending PRs. Further runs
beyond that limit are cancelled by GitHub. Updates to the same contributor PR
also enqueue separate runs; this policy does not deduplicate superseded commits.

The repository owner (`t8y2` here, compared with `github.repository_owner`) is
exempt from author-level limits. Owner PRs retain one cancellation group per PR,
so separate owner PRs run independently and a new commit cancels that PR's old
run. Main pushes retain their independent ref-based cancellation group. These
paths use `queue: single`, never `queue: max` with in-progress cancellation.

This limits main CI workflow runs, not the runner count inside one selected PR.
Other PR workflows and all release workflows remain unchanged. Existing runs
retain their original workflow configuration until a new event uses this policy.

## Selection

`scripts/ci-change-base.mjs` uses the first parent of the checked-out PR test merge
as its base, not the potentially stale base SHA in the PR event. A depth-two
checkout preserves both parents; a missing merge parent fails change detection.
Pushes use the exact event `before` SHA. `paths-filter` uses Git, with an empty API
token and explicit base/head, so its selection matches `scripts/ci-plan.mjs`
rather than a mutable PR file list. An unavailable push diff keeps conservative
planner coverage. Renames include both paths and deleted paths remain visible. Rust package
selection follows reverse dependencies, including build and test dependencies.
Connection-type descriptors belong to `dbx-types`; dialect descriptors belong to
`dbx-sql`. A changed core dependency also selects the standalone DuckDB Agent tests,
whose development dependency is `dbx-core`.

- Ordinary Rust PRs select foundation, driver, and application test groups from
  `scripts/ci-config.mjs`. Each group contains several packages, not one runner per
  crate. The application group includes `dbx-tauri-consul` and `dbx-tauri-schema`.
  At most three Rust test groups run concurrently; a contract checks the groups
  against actual workspace metadata so extracted crates cannot silently force
  every PR into the full-workspace fallback.
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
- Standard Windows compilation follows desktop reverse dependencies, including
  ordinary core/driver source changes. Full Win7 packaging runs for Cargo
  manifests/locks, toolchain/config/vendor changes, platform/update/installer
  code, Tauri configuration, Win7 fixtures/scripts and release/CI workflow inputs.
  Unknown Rust paths, unassigned Rust workspace members and unavailable diffs
  retain both Windows jobs. Other desktop source and test changes keep standard
  Windows compilation without repeating the full Win7 installer build. The final
  gate validates each Windows selection independently; release builds are unchanged.
- Existing frontend, package, JDBC, offline-payload and Nix jobs retain their
  commands and path filters, except for the snapshot-only routing below.

Contributor snapshots refresh weekly, at 02:00 Monday in Asia/Shanghai, and can
still be refreshed manually. An unchanged snapshot keeps its existing timestamp
and creates no commit. A diff containing only `docs/data/contributors.json` skips
desktop frontend validation, but the docs deployment still rebuilds the site.
Mixed diffs and unavailable diffs keep the existing validation routing.

When `fast-checks` is selected, it owns the CI planner and gate tests before
expensive dependent jobs start. `github-scripts` omits that subset in these runs,
but runs every GitHub script test when the fast-check lane is not selected.

Issue command and spam jobs reject irrelevant comments before allocating a
runner. Their existing command parser and malicious-link matcher remain the
authoritative checks. PR notification triggers are commented out; release
notifications in the publishing workflow are unchanged. Plugin development
host lint and formatting run once on Linux before the Linux, macOS and Windows
runtime, Rust and package checks; cross-platform coverage is unchanged.

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
the other selected cases. Go and live matrix parallelism is bounded at four each
to reduce bursts competing with other workflows; this is not a reservation or a
priority guarantee for release jobs. Live test predicates, readiness checks, time limits,
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

## Rust caches and build timings

Linux package, clippy, Rust test and native Agent jobs use the same pinned sccache
compiler wrappers on main and fork PRs. Main uses the existing S3 backend; jobs
without repository secrets use sccache's local disk backend. Only backend settings
are conditional: changing `CC` or `CXX` invalidates native build-script fingerprints
even if a target archive was restored. The cache key retains the real compiler
environment; only the CI selection variables are excluded. Full/fast features and
test-group selection remain unchanged and can still require additional builds.

All Rust target caches use the `v1-rust-complete` namespace and save only after a
successful job, from main. This bypasses old partial snapshots without deleting
caches or changing the S3 namespace. A cancelled or failed first build must not
publish a shared snapshot: rust-cache does not update an exact cache hit, so later
successful builds would otherwise keep restoring the unfinished snapshot.
The first successful main run must populate the new namespace before fork PRs can
reuse it. Target caching is not a per-commit snapshot of workspace artifacts.

Clippy, nextest and native Agent nextest builds emit Cargo HTML timing reports.
Their `DBX-*-cargo-timings` artifacts are retained for three days, including after
failures when a report exists, but uploads do not delay cancelled runs. Inspect
these reports alongside sccache statistics: its hit rate excludes unsupported
crate types and does not measure the time spent compiling and linking test binaries.

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
