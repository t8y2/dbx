#!/usr/bin/env node
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const DEFAULTS = {
  apiBase: "http://127.0.0.1:4224/api",
  container: "dbx-issue-2959-mongo",
  image: "mongo:3.4",
  host: "127.0.0.1",
  port: 12959,
  database: "dbx_issue_2959",
  collection: "large_count",
  expectedCount: 21_606_536,
  iterations: 5,
  warmups: 1,
  seed: false,
  forceSeed: false,
  seedBatchSize: 10_000,
  dbxDataDir: "",
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
      case "host":
        options.host = value;
        break;
      case "port":
        options.port = Number.parseInt(value, 10);
        break;
      case "database":
        options.database = value;
        break;
      case "collection":
        options.collection = value;
        break;
      case "expected-count":
        options.expectedCount = Number.parseInt(value, 10);
        break;
      case "iterations":
        options.iterations = Number.parseInt(value, 10);
        break;
      case "warmups":
        options.warmups = Number.parseInt(value, 10);
        break;
      case "seed":
        options.seed = value !== "false";
        break;
      case "force-seed":
        options.forceSeed = value !== "false";
        break;
      case "seed-batch-size":
        options.seedBatchSize = Number.parseInt(value, 10);
        break;
      case "dbx-data-dir":
        options.dbxDataDir = value;
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
  console.log(`MongoDB count benchmark

Usage:
  pnpm bench:mongodb-count [options]

Options:
  --api-base=http://127.0.0.1:4224/api  DBX Web API base URL
  --container=dbx-issue-2959-mongo       MongoDB Docker container name
  --image=mongo:3.4                      MongoDB image used when creating the container
  --port=12959                           Host port for MongoDB
  --database=dbx_issue_2959              Database name
  --collection=large_count               Collection name
  --expected-count=21606536              Expected collection count
  --iterations=5                         Timed iterations per case
  --warmups=1                            Warmup iterations per case
  --dbx-data-dir=/tmp/dbx-bench          Copy local Mongo agent jar into this DBX data dir
  --seed                                 Seed the collection if its count does not match
  --force-seed                           Drop and reseed even if the collection exists
  --seed-batch-size=10000                Number of docs per insertMany batch
  --json                                 Print JSON only

Before running this benchmark, start DBX Web with the same data dir, for example:
  DBX_DATA_DIR=/tmp/dbx-bench DBX_DISABLE_PASSWORD=1 cargo run -p dbx-web

The benchmark saves one temporary connection into that DBX data dir, so use an
isolated DBX_DATA_DIR instead of your normal desktop profile.
`);
}

function assertInteger(name, value, min = 0) {
  if (!Number.isFinite(value) || Math.trunc(value) !== value || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got ${value}`);
  }
}

function run(command, args, options = {}) {
  const startedAt = performance.now();
  const child = spawn(command, args, {
    cwd: options.cwd ?? process.cwd(),
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

async function ensureMongoContainer(options) {
  try {
    await run("docker", ["inspect", options.container]);
    await run("docker", ["start", options.container]);
  } catch {
    await run("docker", [
      "run",
      "-d",
      "--name",
      options.container,
      "--platform",
      "linux/amd64",
      "-p",
      `${options.host}:${options.port}:27017`,
      options.image,
      "--nojournal",
      "--wiredTigerCacheSizeGB",
      "0.5",
    ]);
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const out = await dockerExec(options.container, ["mongo", "--quiet", "--eval", "db.runCommand({ ping: 1 }).ok"]);
      if (out.stdout.trim().endsWith("1")) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("Timed out waiting for MongoDB container");
}

async function mongoEval(options, script) {
  return dockerExec(options.container, ["mongo", options.database, "--quiet", "--eval", script]);
}

async function collectionCount(options) {
  const out = await mongoEval(options, `print(db.${options.collection}.count())`);
  const line = out.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  return Number.parseInt(line, 10);
}

async function seedMongo(options) {
  const current = await collectionCount(options);
  if (!options.forceSeed && current === options.expectedCount) {
    return { skipped: true, count: current, elapsedMs: 0 };
  }
  if (!options.seed && !options.forceSeed) {
    throw new Error(
      `Collection count is ${current}, expected ${options.expectedCount}. Re-run with --seed to create the benchmark dataset.`,
    );
  }

  const startedAt = performance.now();
  const script = `
    var collection = db.${options.collection};
    collection.drop();
    var expected = ${options.expectedCount};
    var batchSize = ${options.seedBatchSize};
    for (var start = 0; start < expected; start += batchSize) {
      var docs = [];
      var end = Math.min(start + batchSize, expected);
      for (var i = start; i < end; i++) {
        docs.push({ seq: i, bucket: i % 10, payload: "payload-" + i });
      }
      collection.insertMany(docs, { ordered: false });
    }
    print(collection.count());
  `;
  const out = await mongoEval(options, script);
  const count = Number.parseInt(out.stdout.trim().split(/\r?\n/).at(-1) ?? "", 10);
  if (count !== options.expectedCount) {
    throw new Error(`Seed finished with ${count} docs, expected ${options.expectedCount}`);
  }
  return { skipped: false, count, elapsedMs: performance.now() - startedAt };
}

function localMongoAgentJar() {
  return resolve("agents", "drivers", "mongodb", "build", "libs", "dbx-agent-mongodb.jar");
}

function syncMongoAgentJar(options) {
  if (!options.dbxDataDir) return null;
  const source = localMongoAgentJar();
  if (!existsSync(source)) {
    throw new Error(`MongoDB agent jar not found: ${source}. Run ./agents/gradlew -p agents :mongodb:shadowJar first.`);
  }
  const dest = resolve(options.dbxDataDir, "agents", "drivers", "mongodb", "agent.jar");
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  ensureAgentState(options.dbxDataDir);
  return dest;
}

function ensureAgentState(dbxDataDir) {
  const statePath = resolve(dbxDataDir, "agents", "state.json");
  const now = new Date().toISOString();
  let state = {};
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  }
  state.jre_versions ??= {};
  state.installed_drivers ??= {};
  state.installed_drivers.mongodb = {
    version: "0.1.0-local",
    installed_at: state.installed_drivers.mongodb?.installed_at ?? now,
    jre: "21",
  };
  state.java_runtime = {
    ...(state.java_runtime ?? {}),
    mode: "system",
  };
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function postJsonText(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text, json: parseJsonMaybe(text) };
}

function parseJsonMaybe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function ensureDbxConnection(options) {
  const connectionId = `bench-mongodb-count-${options.port}`;
  const config = {
    id: connectionId,
    name: `Bench MongoDB Count ${options.port}`,
    db_type: "mongodb",
    driver_profile: "mongodb-legacy",
    host: options.host,
    port: options.port,
    username: "",
    password: "",
    database: options.database,
    ssl: false,
    connect_timeout_secs: 10,
    query_timeout_secs: 30,
  };

  const save = await postJsonText(`${options.apiBase}/connection/save`, { configs: [config] });
  if (!save.ok) throw new Error(`/connection/save failed with ${save.status}\n${save.text}`);
  const connect = await postJsonText(`${options.apiBase}/connection/connect`, { config });
  if (!connect.ok) throw new Error(`/connection/connect failed with ${connect.status}\n${connect.text}`);
  return connectionId;
}

async function measureCase(label, iterations, warmups, fn) {
  for (let index = 0; index < warmups; index += 1) {
    await fn();
  }
  const samples = [];
  let lastValue;
  let lastPayloadBytes = 0;
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    const result = await fn();
    samples.push(performance.now() - startedAt);
    lastValue = result.value;
    lastPayloadBytes = result.payloadBytes ?? 0;
  }
  samples.sort((a, b) => a - b);
  const sum = samples.reduce((total, value) => total + value, 0);
  return {
    label,
    value: lastValue,
    samples,
    minMs: samples[0],
    p50Ms: percentile(samples, 0.5),
    p90Ms: percentile(samples, 0.9),
    maxMs: samples.at(-1),
    avgMs: sum / samples.length,
    payloadBytes: lastPayloadBytes,
  };
}

function percentile(sortedSamples, p) {
  if (sortedSamples.length === 0) return 0;
  const index = Math.min(sortedSamples.length - 1, Math.ceil(sortedSamples.length * p) - 1);
  return sortedSamples[index];
}

async function measureNativeMongoCount(options) {
  const script = `var r = db.runCommand({ count: "${options.collection}", query: {} }); print(r.n);`;
  const out = await mongoEval(options, script);
  return { value: Number.parseInt(out.stdout.trim().split(/\r?\n/).at(-1) ?? "", 10) };
}

async function measureDbxFindTotal(options, connectionId) {
  const response = await postJsonText(`${options.apiBase}/document-store/find-documents`, {
    connectionId,
    database: options.database,
    collection: options.collection,
    skip: 0,
    limit: 1,
    filter: "{}",
  });
  if (!response.ok) throw new Error(`/document-store/find-documents failed with ${response.status}\n${response.text}`);
  return { value: response.json?.total, payloadBytes: Buffer.byteLength(response.text) };
}

async function measureDbxDedicatedCount(options, connectionId) {
  const response = await postJsonText(`${options.apiBase}/mongo/count-documents`, {
    connectionId,
    database: options.database,
    collection: options.collection,
    filter: "{}",
    mode: "legacy",
  });
  if (!response.ok) {
    return { value: `unavailable (${response.status})`, payloadBytes: Buffer.byteLength(response.text) };
  }
  return { value: response.json, payloadBytes: Buffer.byteLength(response.text) };
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
  console.log("# MongoDB count benchmark");
  console.log("");
  console.log(`- API: ${result.config.apiBase}`);
  console.log(`- MongoDB: ${result.config.container} on ${result.config.host}:${result.config.port}`);
  console.log(`- Collection: ${result.config.database}.${result.config.collection}`);
  console.log(`- Expected count: ${result.config.expectedCount}`);
  console.log(`- Iterations: ${result.config.iterations} timed, ${result.config.warmups} warmup`);
  console.log(`- Seed: ${result.seed.skipped ? "reused existing dataset" : `loaded in ${formatMs(result.seed.elapsedMs)}`}`);
  if (result.agentJar) console.log(`- Synced agent jar: ${result.agentJar}`);
  console.log("");
  console.log("| Case | Value | Payload | Min | P50 | P90 | Max | Avg |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of result.measurements) {
    console.log(
      `| ${row.label} | ${row.value} | ${formatBytes(row.payloadBytes)} | ${formatMs(row.minMs)} | ${formatMs(row.p50Ms)} | ${formatMs(row.p90Ms)} | ${formatMs(row.maxMs)} | ${formatMs(row.avgMs)} |`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertInteger("port", options.port, 1);
  assertInteger("expected-count", options.expectedCount, 1);
  assertInteger("iterations", options.iterations, 1);
  assertInteger("warmups", options.warmups, 0);
  assertInteger("seed-batch-size", options.seedBatchSize, 1);

  if (!options.json) console.log("Preparing MongoDB count benchmark...");
  await ensureMongoContainer(options);
  const seed = await seedMongo(options);
  const agentJar = syncMongoAgentJar(options);

  if (!options.json) console.log("Connecting DBX Web API...");
  const connectionId = await ensureDbxConnection(options);

  const measurements = [
    await measureCase("mongo runCommand count", options.iterations, options.warmups, () => measureNativeMongoCount(options)),
    await measureCase("DBX find-documents total", options.iterations, options.warmups, () => measureDbxFindTotal(options, connectionId)),
    await measureCase("DBX count-documents", options.iterations, options.warmups, () => measureDbxDedicatedCount(options, connectionId)),
  ];

  const result = {
    config: {
      apiBase: options.apiBase,
      container: options.container,
      host: options.host,
      port: options.port,
      database: options.database,
      collection: options.collection,
      expectedCount: options.expectedCount,
      iterations: options.iterations,
      warmups: options.warmups,
    },
    seed,
    agentJar,
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
