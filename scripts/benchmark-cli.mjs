import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const rustBinary = process.env.DBX_CLI_RUST_BIN;
const legacyBinary = process.env.DBX_CLI_LEGACY_BIN;
const connection = process.env.DBX_CLI_TEST_CONNECTION;
const table = process.env.DBX_CLI_TEST_TABLE ?? "orders";
const iterations = Number.parseInt(process.env.DBX_CLI_BENCH_ITERATIONS ?? "12", 10);

if (!rustBinary || !legacyBinary || !connection) {
  throw new Error("Set DBX_CLI_RUST_BIN, DBX_CLI_LEGACY_BIN, and DBX_CLI_TEST_CONNECTION.");
}
if (!Number.isInteger(iterations) || iterations < 3) {
  throw new Error("DBX_CLI_BENCH_ITERATIONS must be an integer of at least 3.");
}

const cases = [
  { name: "version", args: ["--version"], iterations: Math.max(iterations, 30) },
  { name: "capabilities", args: ["capabilities", "--json"], iterations: Math.max(iterations, 30) },
  { name: "connections", args: ["connections", "list", "--json"], iterations: Math.max(iterations, 20) },
  { name: "schema-list", args: ["schema", "list", connection, "--json"], iterations },
  { name: "schema-describe", args: ["schema", "describe", connection, table, "--json"], iterations },
  { name: "context", args: ["context", connection, "--tables", table, "--json"], iterations },
  { name: "query", args: ["query", connection, "select 1 as benchmark_value", "--json"], iterations },
];

function run(binary, args) {
  const started = performance.now();
  const result = spawnSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const elapsed = performance.now() - started;
  if (result.status !== 0) throw new Error(`${binary} ${args.join(" ")} failed: ${result.stderr}`);
  return elapsed;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summarize(values) {
  return {
    median: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p95: percentile(values, 0.95),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function peakRss(binary, args) {
  const values = [];
  for (let index = 0; index < 5; index += 1) {
    const result = spawnSync("/usr/bin/time", ["-l", binary, ...args], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
    if (result.status !== 0) throw new Error(`RSS measurement failed: ${result.stderr}`);
    const match = result.stderr.match(/(\d+)\s+maximum resident set size/);
    if (!match) throw new Error(`Unable to parse maximum resident set size: ${result.stderr}`);
    values.push(Number(match[1]) / 1024 / 1024);
  }
  return percentile(values, 0.5);
}

console.log(`iterations=${iterations} connection=${connection} table=${table}`);
console.log("case\truntime\tmedian_ms\tp90_ms\tp95_ms\tmean_ms\tpeak_rss_mib");

for (const benchmark of cases) {
  run(rustBinary, benchmark.args);
  run(legacyBinary, benchmark.args);
  const samples = { rust: [], legacy: [] };
  for (let index = 0; index < benchmark.iterations; index += 1) {
    const order = index % 2 === 0 ? [["rust", rustBinary], ["legacy", legacyBinary]] : [["legacy", legacyBinary], ["rust", rustBinary]];
    for (const [runtime, binary] of order) samples[runtime].push(run(binary, benchmark.args));
  }
  for (const [runtime, binary] of [["rust", rustBinary], ["legacy", legacyBinary]]) {
    const stats = summarize(samples[runtime]);
    const rss = peakRss(binary, benchmark.args);
    console.log(
      `${benchmark.name}\t${runtime}\t${stats.median.toFixed(1)}\t${stats.p90.toFixed(1)}\t${stats.p95.toFixed(1)}\t${stats.mean.toFixed(1)}\t${rss.toFixed(1)}`,
    );
  }
}
