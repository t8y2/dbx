#!/usr/bin/env node
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const DEFAULTS = {
  apiBase: "http://127.0.0.1:4224/api",
  container: "dbx_bench_redis_key_search",
  image: "redis:7-alpine",
  host: "127.0.0.1",
  port: 16151,
  db: 0,
  keyCount: 1_000_000,
  keyPrefix: "user:",
  pattern: "user:*",
  scanCount: 10_000,
  maxIterations: 15,
  includeTyped: true,
  json: false,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (const arg of argv) {
    if (arg === "--") continue;
    const [rawKey, rawValue] = arg.split("=", 2);
    const key = rawKey.replace(/^--/, "");
    const value = rawValue ?? "true";
    switch (key) {
      case "api-base":
        options.apiBase = value;
        break;
      case "container":
        options.container = value;
        break;
      case "image":
        options.image = value;
        break;
      case "port":
        options.port = Number.parseInt(value, 10);
        break;
      case "key-count":
        options.keyCount = Number.parseInt(value, 10);
        break;
      case "key-prefix":
        options.keyPrefix = value;
        break;
      case "pattern":
        options.pattern = value;
        break;
      case "scan-count":
        options.scanCount = Number.parseInt(value, 10);
        break;
      case "max-iterations":
        options.maxIterations = Number.parseInt(value, 10);
        break;
      case "typed":
        options.includeTyped = value !== "false";
        break;
      case "json":
        options.json = value !== "false";
        break;
      case "help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${rawKey}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Redis key search benchmark

Usage:
  pnpm bench:redis-key-search [options]

Options:
  --api-base=http://127.0.0.1:4224/api  DBX Web API base URL
  --container=dbx_bench_redis_key_search Redis Docker container name
  --port=16151                              Host port for Redis
  --key-count=1000000                       Number of generated keys
  --pattern=user:*                          SCAN MATCH pattern
  --scan-count=10000                        DBX SCAN COUNT value
  --max-iterations=15                       DBX server-side SCAN iterations per API call
  --typed=false                             Skip DBX includeTypes=true comparison
  --json                                    Print JSON only

Before running this benchmark, start DBX Web separately, for example:
  DBX_DATA_DIR=/tmp/dbx-bench DBX_PORT=4224 DBX_DISABLE_PASSWORD=1 cargo run -p dbx-web
`);
}

function assertFinitePositiveInteger(name, value) {
  if (!Number.isFinite(value) || value <= 0 || Math.trunc(value) !== value) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
}

function run(command, args, options = {}) {
  const startedAt = performance.now();
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  if (child.stdout) child.stdout.on("data", (chunk) => stdout.push(chunk));
  if (child.stderr) child.stderr.on("data", (chunk) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        elapsedMs: performance.now() - startedAt,
      };
      if (code === 0) resolve(result);
      else reject(new Error(`${command} ${args.join(" ")} failed with ${code}\n${result.stderr || result.stdout}`));
    });
  });
}

async function dockerExec(container, args) {
  return run("docker", ["exec", container, ...args]);
}

async function ensureRedisContainer(options) {
  try {
    await run("docker", ["inspect", options.container]);
    await run("docker", ["start", options.container]);
  } catch {
    await run("docker", [
      "run",
      "-d",
      "--name",
      options.container,
      "-p",
      `${options.host}:${options.port}:6379`,
      options.image,
      "redis-server",
      "--save",
      "",
      "--appendonly",
      "no",
    ]);
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const pong = (await dockerExec(options.container, ["redis-cli", "PING"])).stdout.trim();
      if (pong === "PONG") return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("Timed out waiting for Redis container");
}

async function redisDbSize(container) {
  const out = await dockerExec(container, ["redis-cli", "DBSIZE"]);
  return Number.parseInt(out.stdout.trim(), 10);
}

function redisSetCommand(key, value = "1") {
  const keyBytes = Buffer.byteLength(key);
  const valueBytes = Buffer.byteLength(value);
  return `*3\r\n$3\r\nSET\r\n$${keyBytes}\r\n${key}\r\n$${valueBytes}\r\n${value}\r\n`;
}

async function seedRedis(options) {
  const currentSize = await redisDbSize(options.container);
  if (currentSize === options.keyCount) return { skipped: true, elapsedMs: 0 };

  await dockerExec(options.container, ["redis-cli", "FLUSHALL"]);

  const startedAt = performance.now();
  const child = spawn("docker", ["exec", "-i", options.container, "redis-cli", "--pipe"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const width = Math.max(7, String(options.keyCount - 1).length);
  for (let index = 0; index < options.keyCount; index += 1) {
    const key = `${options.keyPrefix}${String(index).padStart(width, "0")}`;
    if (!child.stdin.write(redisSetCommand(key))) {
      await new Promise((resolve) => child.stdin.once("drain", resolve));
    }
  }
  child.stdin.end();

  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`redis-cli --pipe failed with ${code}\n${Buffer.concat(stderr).toString()}`));
    });
  });

  return { skipped: false, elapsedMs: performance.now() - startedAt };
}

async function measureRedisCliScan(options) {
  const startedAt = performance.now();
  const child = spawn("docker", ["exec", options.container, "redis-cli", "--scan", "--pattern", options.pattern], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let count = 0;
  let pending = "";
  const stderr = [];

  child.stdout.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    count += lines.filter(Boolean).length;
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (pending.trim()) count += 1;
      if (code === 0) resolve();
      else reject(new Error(`redis-cli --scan failed with ${code}\n${Buffer.concat(stderr).toString()}`));
    });
  });

  return { label: "redis-cli --scan", keys: count, elapsedMs: performance.now() - startedAt };
}

async function postJsonText(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} ${response.status}\n${text}`);
  return { text, json: JSON.parse(text) };
}

async function ensureDbxConnection(options) {
  const connectionId = `bench-redis-key-search-${options.port}`;
  const config = {
    id: connectionId,
    name: `Bench Redis Key Search ${options.port}`,
    db_type: "redis",
    host: options.host,
    port: options.port,
    username: "",
    password: "",
    database: String(options.db),
    auth_database: "",
    ssl: false,
    redis_key_separator: ":",
    connection_timeout: 10,
    connect_timeout_secs: 10,
  };

  await postJsonText(`${options.apiBase}/connection/save`, { configs: [config] });
  await postJsonText(`${options.apiBase}/connection/connect`, { config });
  return connectionId;
}

async function measureDbxScan(options, connectionId, includeTypes) {
  let cursor = 0;
  let calls = 0;
  let keys = 0;
  let payloadBytes = 0;
  const startedAt = performance.now();

  do {
    const { text, json } = await postJsonText(`${options.apiBase}/redis/scan-keys-batch`, {
      connectionId,
      db: options.db,
      cursor,
      pattern: options.pattern,
      count: options.scanCount,
      maxIterations: options.maxIterations,
      includeTypes,
    });
    payloadBytes += Buffer.byteLength(text);
    cursor = json.cursor;
    keys += json.keys.length;
    calls += 1;
  } while (cursor !== 0);

  return {
    label: includeTypes ? "DBX scan-keys-batch includeTypes=true" : "DBX scan-keys-batch includeTypes=false",
    keys,
    calls,
    payloadBytes,
    elapsedMs: performance.now() - startedAt,
  };
}

function formatMs(ms) {
  return `${Math.round(ms)}ms`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function printReport(result) {
  console.log("# Redis key search benchmark");
  console.log("");
  console.log(`- API: ${result.config.apiBase}`);
  console.log(`- Redis: ${result.config.container} on ${result.config.host}:${result.config.port}`);
  console.log(`- Keys: ${result.config.keyCount}`);
  console.log(`- Pattern: ${result.config.pattern}`);
  console.log(`- DBX scan count: ${result.config.scanCount}`);
  console.log(`- DBX max iterations: ${result.config.maxIterations}`);
  console.log(`- Seed: ${result.seed.skipped ? "reused existing dataset" : `loaded in ${formatMs(result.seed.elapsedMs)}`}`);
  console.log("");
  console.log("| Case | Keys | Calls | Payload | Time |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const row of result.measurements) {
    console.log(`| ${row.label} | ${row.keys} | ${row.calls ?? "-"} | ${row.payloadBytes ? formatBytes(row.payloadBytes) : "-"} | ${formatMs(row.elapsedMs)} |`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertFinitePositiveInteger("port", options.port);
  assertFinitePositiveInteger("key-count", options.keyCount);
  assertFinitePositiveInteger("scan-count", options.scanCount);
  assertFinitePositiveInteger("max-iterations", options.maxIterations);

  if (!options.json) {
    console.log("Preparing Redis benchmark dataset...");
  }
  await ensureRedisContainer(options);
  const seed = await seedRedis(options);

  if (!options.json) {
    console.log("Connecting DBX Web API...");
  }
  const connectionId = await ensureDbxConnection(options);

  const measurements = [];
  measurements.push(await measureRedisCliScan(options));
  measurements.push(await measureDbxScan(options, connectionId, false));
  if (options.includeTyped) {
    measurements.push(await measureDbxScan(options, connectionId, true));
  }

  const result = {
    config: {
      apiBase: options.apiBase,
      container: options.container,
      host: options.host,
      port: options.port,
      keyCount: options.keyCount,
      pattern: options.pattern,
      scanCount: options.scanCount,
      maxIterations: options.maxIterations,
    },
    seed,
    measurements,
    generatedAt: new Date().toISOString(),
  };

  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printReport(result);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
