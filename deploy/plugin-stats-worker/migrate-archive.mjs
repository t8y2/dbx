#!/usr/bin/env node
// One-shot migration: legacy per-counter KV keys -> the single archive document.
//
// Legacy layout (one KV key per counter, what filled the free-plan
// "1,000 different keys per day" quota):
//   total:{kind}:{plugin}:{version}  -> cumulative events
//   uniqd:{kind}:{plugin}:{day}      -> per-day distinct identities
//   meta:last-success                -> window watermark
//   summary                          -> public {kind: {plugin: count}} blob
//
// New layout (read/modified/written by worker.ts as one value):
//   archive:v2 = {v:2, lastSuccess, total:{"kind:plugin:version": n},
//                 uniqd:{"kind:plugin:day": n}}
//
// The legacy keys are never deleted here, so a bad run cannot lose history:
// the only write is the new document, and --apply re-reads it and compares.
//
// Usage:
//   node migrate-archive.mjs            # dry run: read everything, verify, print
//   node migrate-archive.mjs --apply    # write archive:v2, verify read-back
//   node migrate-archive.mjs --apply --force   # overwrite an existing archive:v2
// Flags: --out=<file> --account=<id> --namespace=<id>
// Auth: CLOUDFLARE_API_TOKEN, or the wrangler OAuth refresh token (the script
// refreshes it and writes the new tokens back to the wrangler config file).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { accessToken, api, apiText, bulkGet, listKeys } from "./cf-kv-api.mjs";

const ARCHIVE_KEY = "archive:v2";
const ARCHIVE_VERSION = 2;
const SUMMARY_KEY = "summary";
const META_KEY = "meta:last-success";
const LEGACY_PREFIXES = ["total:", "uniqd:"];

function parseArgs(argv) {
  const args = { apply: false, force: false, out: null, account: "7ad3349ede62c17968a90108d39fd4d0", namespace: "0cc9e49a117f4edeb931464fa0256834" };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--force") args.force = true;
    else if (arg.startsWith("--out=")) args.out = arg.slice(6);
    else if (arg.startsWith("--account=")) args.account = arg.slice(10);
    else if (arg.startsWith("--namespace=")) args.namespace = arg.slice(12);
    else if (arg === "--help" || arg === "-h") {
      console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 22).join("\n"));
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/** Legacy key -> document key. `total:`/`uniqd:` are both 6 chars. */
export function documentKey(legacyKey) {
  if (legacyKey.startsWith("total:")) return { section: "total", key: legacyKey.slice("total:".length) };
  if (legacyKey.startsWith("uniqd:")) return { section: "uniqd", key: legacyKey.slice("uniqd:".length) };
  return null;
}

/**
 * Pure builder: legacy {key: value} entries -> archive document.
 * Throws on a malformed legacy key or value instead of skipping it silently.
 */
export function buildArchive(entries) {
  const doc = { v: ARCHIVE_VERSION, lastSuccess: "", total: {}, uniqd: {} };
  const problems = [];
  for (const [legacyKey, rawValue] of entries) {
    if (legacyKey === META_KEY) {
      doc.lastSuccess = String(rawValue).trim();
      continue;
    }
    const mapped = documentKey(legacyKey);
    if (!mapped) continue; // agg:*, summary, archive:v2 — handled separately
    const value = Number.parseInt(String(rawValue), 10);
    if (!/^\d+$/.test(String(rawValue).trim()) || !Number.isSafeInteger(value)) {
      problems.push(`${legacyKey}: non-integer value ${JSON.stringify(rawValue)}`);
      continue;
    }
    // `total:` holds both shapes written by the old aggregator: the
    // per-version counters (`kind:plugin:version`) and the plugin rollups
    // (`kind:plugin`). `uniqd:` is always `kind:plugin:day`.
    const parts = mapped.key.split(":");
    const validLengths = mapped.section === "total" ? [2, 3] : [3];
    if (!validLengths.includes(parts.length)) {
      problems.push(`${legacyKey}: unexpected shape ${JSON.stringify(mapped.key)}`);
      continue;
    }
    if (mapped.section === "total") doc.total[mapped.key] = value;
    else doc.uniqd[mapped.key] = value;
  }
  if (problems.length) throw new Error(`malformed legacy entries:\n  ${problems.slice(0, 20).join("\n  ")}`);
  return doc;
}

/** Every legacy entry must survive into the document with the same value. */
export function verifyArchive(doc, entries) {
  const problems = [];
  const expected = { total: new Map(), uniqd: new Map() };
  for (const [legacyKey, rawValue] of entries) {
    const mapped = documentKey(legacyKey);
    if (!mapped) {
      if (legacyKey === META_KEY && String(rawValue).trim() !== doc.lastSuccess) {
        problems.push(`lastSuccess mismatch: legacy ${JSON.stringify(rawValue)} vs doc ${JSON.stringify(doc.lastSuccess)}`);
      }
      continue;
    }
    expected[mapped.section].set(mapped.key, Number.parseInt(String(rawValue), 10));
  }
  for (const section of ["total", "uniqd"]) {
    const stored = doc[section] ?? {};
    if (Object.keys(stored).length !== expected[section].size) {
      problems.push(`${section}: doc has ${Object.keys(stored).length} entries, legacy has ${expected[section].size}`);
    }
    for (const [key, value] of expected[section]) {
      if (stored[key] !== value) problems.push(`${section}[${key}]: doc ${JSON.stringify(stored[key])} vs legacy ${value}`);
    }
  }
  return problems;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = await accessToken();
  const base = `/accounts/${args.account}/storage/kv/namespaces/${args.namespace}`;

  console.log(`listing keys in ${args.namespace} ...`);
  const allKeys = await listKeys(token, args.account, args.namespace);
  const legacyKeys = allKeys.filter((key) => key === META_KEY || LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix)));
  console.log(`  ${allKeys.length} keys total, ${legacyKeys.length} legacy counter keys`);

  console.log("bulk reading legacy values ...");
  const entries = new Map(Object.entries(await bulkGet(token, args.account, args.namespace, legacyKeys)));
  const doc = buildArchive(entries);
  const problems = verifyArchive(doc, entries);
  if (problems.length) {
    console.error(`verification failed (${problems.length}):`);
    for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
    process.exit(1);
  }

  const serialized = JSON.stringify(doc);
  const bytes = Buffer.byteLength(serialized);
  console.log(`built ${ARCHIVE_KEY}: ${Object.keys(doc.total).length} counters, ${Object.keys(doc.uniqd).length} unique-days, ${(bytes / 1024).toFixed(1)} KiB`);
  console.log(`  lastSuccess: ${doc.lastSuccess || "(empty)"}`);
  console.log(`  sha256: ${sha256(serialized)}`);

  if (!args.apply) {
    const out = args.out ?? path.join(os.tmpdir(), "archive-v2.dry-run.json");
    fs.writeFileSync(out, serialized);
    console.log(`dry run: wrote ${out}; re-run with --apply to upload`);
    return;
  }

  const existing = await apiText(token, `${base}/values/${encodeURIComponent(ARCHIVE_KEY)}`).catch((error) =>
    error.status === 404 ? null : Promise.reject(error),
  );
  if (existing !== null && !args.force) {
    // Already migrated: verify the stored document still matches the legacy
    // keys instead of overwriting it.
    const storedProblems = verifyArchive(JSON.parse(existing), entries);
    if (storedProblems.length) {
      console.error(`existing ${ARCHIVE_KEY} does not match the legacy keys (${storedProblems.length}):`);
      for (const problem of storedProblems.slice(0, 20)) console.error(`  ${problem}`);
      process.exit(1);
    }
    console.log(`${ARCHIVE_KEY} already exists and matches the legacy keys; nothing to write`);
    return;
  }

  console.log(`writing ${ARCHIVE_KEY} (${(bytes / 1024).toFixed(1)} KiB) ...`);
  await api(token, "PUT", `${base}/values/${encodeURIComponent(ARCHIVE_KEY)}`, serialized, { raw: true });

  // Read back through the same API and diff, so a truncated/encoded upload is
  // caught before anyone trusts the document.
  const stored = await apiText(token, `${base}/values/${encodeURIComponent(ARCHIVE_KEY)}`);
  const roundTrip = verifyArchive(JSON.parse(stored), entries);
  if (roundTrip.length) {
    console.error(`read-back verification failed (${roundTrip.length}):`);
    for (const problem of roundTrip.slice(0, 20)) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`ok: ${ARCHIVE_KEY} stored and verified; legacy keys untouched`);
  console.log(`  summary: ${SUMMARY_KEY} left as-is (the new Worker keeps updating it)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
