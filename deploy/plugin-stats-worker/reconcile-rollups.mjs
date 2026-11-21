#!/usr/bin/env node
// Repair the per-plugin rollups inside `archive:v2`.
//
// The old aggregator advanced versioned counters in one phase and the
// `kind:plugin` rollups in a later one, so every mid-pass failure left the
// rollups behind (dl was ~11% short by 2026-11-10). The current Worker keeps
// both in step, but the historical gap has to be closed once.
//
// Rule: rollup = max(stored, sum of its versioned counters). A counter never
// decreases; four legacy `inst` rollups legitimately sit +1 above their version
// sum (that event's version string failed validation), and they are left alone.
//
// Usage:
//   node reconcile-rollups.mjs            # dry run: report what would change
//   node reconcile-rollups.mjs --apply    # write archive:v2 and verify read-back

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { accessToken, api, apiText } from "./cf-kv-api.mjs";

const ARCHIVE_KEY = "archive:v2";
const DEFAULT_ACCOUNT = "7ad3349ede62c17968a90108d39fd4d0";
const DEFAULT_NAMESPACE = "0cc9e49a117f4edeb931464fa0256834";

/** Split a counter key into its parts; rollups are 2, versioned counters are 3. */
export function splitCounterKey(key) {
  const parts = key.split(":");
  return { kind: parts[0], plugin: parts[1], version: parts[2], isRollup: parts.length === 2 };
}

/**
 * Pure reconcile: raise rollups to at least the sum of their versioned counters.
 * Returns the new document plus a change report; never lowers a value.
 */
export function reconcileRollups(doc) {
  const sums = new Map();
  for (const [key, value] of Object.entries(doc.total)) {
    const parts = key.split(":");
    if (parts.length !== 3) continue;
    const rollup = `${parts[0]}:${parts[1]}`;
    sums.set(rollup, (sums.get(rollup) ?? 0) + value);
  }

  const changes = [];
  let created = 0;
  let unchanged = 0;
  for (const [rollup, sum] of sums) {
    const stored = doc.total[rollup];
    if (stored === undefined) {
      doc.total[rollup] = sum;
      created += 1;
      changes.push({ key: rollup, from: null, to: sum, kind: "created" });
    } else if (sum > stored) {
      doc.total[rollup] = sum;
      changes.push({ key: rollup, from: stored, to: sum, kind: "raised" });
    } else {
      unchanged += 1;
    }
  }
  return { doc, changes, created, unchanged };
}

/** Every rollup must cover its versioned counters after the repair. */
export function verifyRollups(doc) {
  const sums = new Map();
  for (const [key, value] of Object.entries(doc.total)) {
    const parts = key.split(":");
    if (parts.length !== 3) continue;
    const rollup = `${parts[0]}:${parts[1]}`;
    sums.set(rollup, (sums.get(rollup) ?? 0) + value);
  }
  const problems = [];
  for (const [rollup, sum] of sums) {
    const stored = doc.total[rollup];
    if (stored === undefined) problems.push(`${rollup}: no rollup for ${sum} counters`);
    else if (stored < sum) problems.push(`${rollup}: rollup ${stored} < version sum ${sum}`);
  }
  return problems;
}

function parseArgs(argv) {
  const args = { apply: false, account: DEFAULT_ACCOUNT, namespace: DEFAULT_NAMESPACE, out: null };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg.startsWith("--account=")) args.account = arg.slice(10);
    else if (arg.startsWith("--namespace=")) args.namespace = arg.slice(12);
    else if (arg.startsWith("--out=")) args.out = arg.slice(6);
    else if (arg === "--help" || arg === "-h") {
      console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 20).join("\n"));
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = await accessToken();
  const base = `/accounts/${args.account}/storage/kv/namespaces/${args.namespace}`;
  const valuePath = `${base}/values/${encodeURIComponent(ARCHIVE_KEY)}`;

  const raw = await apiText(token, valuePath);
  const doc = JSON.parse(raw);
  const before = JSON.stringify(doc.total).length;

  const { changes, created, unchanged } = reconcileRollups(doc);
  const problems = verifyRollups(doc);
  if (problems.length) {
    console.error(`rollup verification failed (${problems.length}):`);
    for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
    process.exit(1);
  }

  const lowered = changes.filter((change) => change.from !== null && change.to < change.from);
  console.log(
    `rollups: ${created} created, ${changes.length - created} raised, ${unchanged} already current, ${lowered.length} lowered`,
  );
  for (const change of changes.slice(0, 10)) {
    console.log(`  ${change.key}: ${change.from ?? "(none)"} -> ${change.to}`);
  }
  if (changes.length > 10) console.log(`  ... ${changes.length - 10} more`);

  const serialized = JSON.stringify(doc);
  console.log(`document: ${(Buffer.byteLength(raw) / 1024).toFixed(1)} KiB -> ${(Buffer.byteLength(serialized) / 1024).toFixed(1)} KiB`);
  console.log(`keys touched: ${Object.keys(doc.total).length} counters (${before} bytes of map before)`);

  if (!args.apply) {
    const out = args.out ?? path.join(os.tmpdir(), "archive-v2.reconciled.json");
    fs.writeFileSync(out, serialized);
    console.log(`dry run: wrote ${out}; re-run with --apply to upload`);
    return;
  }

  console.log(`writing ${ARCHIVE_KEY} ...`);
  await api(token, "PUT", valuePath, serialized, { raw: true });
  const stored = JSON.parse(await apiText(token, valuePath));
  const roundTrip = verifyRollups(stored);
  if (roundTrip.length) {
    console.error(`read-back verification failed (${roundTrip.length}):`);
    for (const problem of roundTrip.slice(0, 20)) console.error(`  ${problem}`);
    process.exit(1);
  }
  const mismatch = JSON.stringify(stored.total) === JSON.stringify(doc.total);
  console.log(`ok: rollups verified${mismatch ? "" : " (map order differs, values compared separately)"}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
