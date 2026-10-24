# MCP Redis decoding implementation plan

> Execute using the foundation workflow, test-first codec changes, independent
> parser tasks, integration validation and read-only code review.

**Goal:** Give MCP clients structured Redis values for Java Object Serialization,
MessagePack, Pickle, PHP Serialize and schema-less Protobuf, including compressed
values, while preserving default command output and original-text fallback.

**Spec:** https://github.com/t8y2/dbx/issues/12922. The user subsequently requested
all remaining codecs and the desktop's gzip/zlib/raw-DEFLATE decompression in the
same PR, extending the initially delivered Java-only scope.

**Architecture:** Data-only Rust parsers and streaming decompression live in
`dbx-formats`. MCP reverses the Redis driver's lossless byte display, unwraps a
selected/recognized compression format, and applies the selected/detected codec.
Each string leaf receives one bounded processing allowance and all leaves share
a command allowance. Existing execution authorization runs before this output
processing. Shared fixtures compare Rust and desktop TypeScript conventions.

**Tech stack:** Rust, serde_json, base64, num-bigint, flate2/zlib-rs,
rmcp/schemars, Vitest, Python/Java-generated fixture bytes.

## API and acceptance

- `decode`: optional `auto`, `java-serialized`, `msgpack`, `pickle`,
  `php-serialize`, `protobuf`.
- `decompress`: optional `auto`, `gzip`, `zlib`, `deflate`; usable independently.
- Omit both arguments for unchanged output. Valid results contain `value` and
  the applicable `codec`/`compression` metadata. Invalid or unsupported input
  retains the original display. Compound replies process string leaves only.
- Auto decoding recognizes complete Java streams, Pickle protocol 2-5 headers,
  PHP serialization and MessagePack containers. MessagePack scalars and legacy
  Pickle protocol 0/1 require explicit selection; Protobuf is never detected.
- Decode requests can automatically unwrap checksum-verified gzip/zlib. Raw
  DEFLATE requires explicit selection. Gzip concatenated members are supported;
  trailing garbage/truncation/checksum failures retain the original value.
- Decompression alone returns UTF-8 or binary `{ "$bytes": "<base64>" }`.
- Unsafe integers remain exact decimal strings; Java longs always remain strings.
  Java reference/inheritance metadata and ordinary desktop codec output are
  preserved. Protobuf fields are numeric, varints unsigned, fixed32/64 raw hex;
  nested/text/bytes are inferred without .proto-specific type guesses.

```json
{"connection_id":"redis","command":"GET cache","decode":"msgpack","decompress":"gzip"}
```

Example result:
`{"codec":"msgpack","compression":"gzip","value":{"task":"add","value":3}}`.

## Safety constraints

- 1 MiB original input and decompressed output per value; depth 64; 32,768 nodes.
- 4 MiB work across each full value pipeline; 16 MiB across the command reply.
  Failed parsing and heuristic attempts consume budget. Charge allocations and
  escaping before extending buffers; stop inflate while it produces output.
- No Java/Python/PHP class loading, constructors, global functions or callbacks
  execute. Pickle callables and object classes remain inert tagged metadata.
- Unsupported constructs fall back, including MessagePack extensions/timestamps,
  PHP references/custom serialization/nonfinite doubles, Pickle persistent IDs,
  extension registry entries, out-of-band buffers and unsupported timezone data.
- Preserve original connection/database scope, read-only and production checks.
- Keep all work on the existing isolated branch and update PR #12956 only.

## Tasks

- [x] Implement bounded Java arena parsing and normalization with real Java
  fixtures, cycles, superclass metadata, annotations, collections and malformed
  descriptor/UTF-16/resource regression tests.
- [x] Add `DecodeBudget` shared helpers and independently implement MessagePack,
  PHP, Pickle and Protobuf with focused RED/GREEN tests. Preserve container kinds,
  dictionary overwrite/reference timing, BOM behavior, calendar/arity validation
  and budgeted composite-key serialization.
- [x] Implement gzip/zlib/raw-DEFLATE with incremental output limits, checksums,
  complete input, concatenated gzip and bomb/truncation/trailing-input tests.
- [x] Integrate MCP codec/compression options with concrete optional string
  schemas, conservative auto detection, default/fallback tests and aggregate
  compressed/uncompressed reply budget tests.
- [x] Add 25 shared Rust/desktop codec fixtures, 18 additional real Python Pickle
  fixtures and 24 compression cases. Extend live Redis/MCP coverage to 63
  fixture GETs, mixed MGET, raw fallback/default and a 21 KB Java value.
- [x] Update English/Chinese MCP docs, including supported modes and fallbacks.
- [x] Complete independent read-only review and address all reported findings.
- [x] Complete Cargo/MCP/protocol/live Redis validation, strict Clippy, targeted
  formatting and final evidence.

Delivery: append the verified changes to `codex/issue-12922-redis-decode`, push to
`caichangqing1120/dbx`, and update the existing PR #12956 against `t8y2/dbx:main`.

## Validation commands

```sh
cargo test -p dbx-formats --locked --offline
RUST_MIN_STACK=8388608 cargo test -p dbx-mcp --no-default-features --features sqlite-bundled --lib --test protocol --test live_redis_decode --locked --offline -- --include-ignored
pnpm exec vitest run packages/app-tests/redisCodecParity.test.ts packages/app-tests/redisJavaCodec.test.ts packages/app-tests/redisValuePresentation.test.ts apps/desktop/src/lib/redis/codec/__tests__
cargo fmt -p dbx-formats -p dbx-mcp -- --check
```

Final results: 161 formats library tests + 1 shared codec integration suite + 7
Java integration tests passed; 212 MCP library tests, 14 protocol tests and the
real Redis/MCP transport test passed; 107 desktop tests in 9 files passed. Both
`dbx-formats` and `dbx-mcp` passed Clippy with `--all-targets --no-deps -- -D warnings`
(the MCP command uses the same no-default-features/sqlite-bundled configuration).
Formatting and whitespace checks passed. The 24 frozen source/fixture/manifest
input hashes still matched after validation. The test-owned Redis process exited.
Independent review approved the implementation after replaying all reported
Pickle failures, 18 Python fixtures and 30 calendar/time round trips.

Rust builds use reduced development/test debug output and disabled incremental
compilation for local disk usage. The no-default-features build has existing
unused/dead-code warnings in unchanged `dbx-core` files. Full desktop/workspace
builds are outside this focused validation scope.

## CI standalone lock validation

The standalone DuckDB `Cargo.lock` includes `dbx-formats`' direct base64, flate2
and num-bigint dependency edges; package versions remain unchanged. Verified the
same `CI_PLAN` and `.github/scripts/ci-lockfiles.mjs` used by run 39536127203:
root workspace, DuckDB and TDengine locked metadata all pass. CI planner/gate
checks pass 112/112, architecture checks pass 28/28, generated connection types
and grouped Rust feature coverage pass. The local planner tests use a temporary
`+stable` argument adapter for the installed stable Homebrew Cargo because this
host has no rustup proxy; Cargo metadata itself still runs against real manifests.
