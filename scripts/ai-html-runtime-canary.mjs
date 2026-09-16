#!/usr/bin/env node

/**
 * AI HTML preview runtime canary — repeatable E2E runner (PRD R8).
 *
 * PRD requires runtime evidence in TWO contexts for the safe-HTML boundary, not
 * just a CSP string assertion:
 *
 *   Context A — the in-app iframe preview: the sandboxed iframe (`sandbox=""`)
 *               inside the manually generated harness.
 *   Context B — the standalone wrapped file that "Save Safe HTML" writes:
 *               opened directly in the browser, OUTSIDE the sandbox, where the
 *               inlined CSP meta alone must hold. This is exactly the scene in
 *               which `form-action 'none'` / `base-uri 'none'` must be proven
 *               (they do not inherit `default-src`).
 *
 * For each context a headless Chromium run captures a `--log-net-log` trace and
 * a `--dump-dom`. PASS means: both netlogs are non-empty and contain URL_REQUEST
 * events (guards against a broken capture producing a vacuous pass), neither
 * netlog contains a request to `canary.invalid`, and neither DOM dump shows a
 * script-execution trace — the SCRIPT-RAN / ONERROR-RAN title markers (raw
 * strings in the source text do not count: the regexes match element serialized
 * output only) or a red document background.
 *
 * Browser discovery: AI_HTML_CANARY_BROWSER overrides; otherwise standard
 * install paths for Microsoft Edge / Google Chrome are probed (win32, darwin,
 * linux). A failure to find a browser prints guidance and exits non-zero.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const CANARY_SPEC = "apps/desktop/src/lib/ai/richContent/__tests__/aiHtmlPreviewCanary.spec.ts";
const HEADLESS_ARGS = [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
];

const BROWSER_CANDIDATES = process.platform === "win32"
  ? [
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    ]
  : process.platform === "darwin"
    ? [
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ]
    : ["msedge", "google-chrome", "chromium", "chromium-browser"];

function browserCandidates() {
  const override = process.env.AI_HTML_CANARY_BROWSER;
  if (override) return [override];
  return BROWSER_CANDIDATES.filter((candidate) => {
    if (candidate.includes("/") || candidate.includes("\\")) return existsSync(candidate);
    return spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0;
  });
}

function resolveBrowser() {
  const candidates = browserCandidates();
  if (candidates.length === 0) {
    throw new Error(`No Chromium-based browser found for this platform. Set AI_HTML_CANARY_BROWSER to the msedge/chrome executable.`);
  }
  return candidates[0];
}

/** Invoke vitest from the repository root so the `@` alias and vitest config resolve. */
function runVitestHarness(harnessOutPath) {
  const vitestBin = resolve(REPO_ROOT, "node_modules/vitest/vitest.mjs");
  if (!existsSync(vitestBin)) throw new Error(`vitest entry not found at ${vitestBin}; run pnpm install first`);
  const args = ["--no-warnings", vitestBin, "run", CANARY_SPEC];
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, AI_HTML_CANARY_OUT: harnessOutPath },
  });
  if (result.status !== 0) {
    throw new Error(`vitest harness generation failed (exit ${result.status})\n${result.stdout}${result.stderr}`);
  }
}

/**
 * Recover the wrapped payload the harness embeds verbatim: the spec writes the
 * exact bytes `buildSafeHtmlPreview` produces into a Blob constructor. Parse the
 * JSON literal back out and verify it round-trips (a second parse returns the
 * identical string) before it stands in for the "Save Safe HTML" payload.
 */
function extractWrappedPayload(harness) {
  const match = harness.match(/new Blob\(\[([\s\S]*?)\], \{type: "text\/html"\}\)/);
  if (!match) throw new Error(`Could not extract wrapped payload from harness ${harness}`);
  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    throw new Error("Wrapped payload in harness is not valid JSON");
  }
  if (JSON.parse(match[1]) !== payload) {
    throw new Error("Wrapped payload did not round-trip through JSON.stringify");
  }
  if (!payload.includes("Content-Security-Policy")) {
    throw new Error("Wrapped payload has no CSP meta; cannot serve as the safe standalone file");
  }
  return payload;
}

/** Run one context: fileUrl is the harness (A) or the wrapped file (B). */
function runHeadless(browser, filePath, userDataDir, netlogPath) {
  const fileUrl = pathToFileURL(filePath).href;
  const dumpPath = `${netlogPath}.dom.html`;
  const args = [
    ...HEADLESS_ARGS,
    `--user-data-dir=${userDataDir}`,
    `--log-net-log=${netlogPath}`,
    "--virtual-time-budget=8000",
    "--dump-dom",
    fileUrl,
  ];
  let dom = "";
  try {
    dom = execFileSync(browser, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // --dump-dom can still exit non-zero on some versions even after writing output.
    dom = error.stdout ? String(error.stdout) : "";
  }
  writeFileSync(dumpPath, dom, "utf8");
  return { dom, dumpPath };
}

function analyzeNetlog(netlogPath) {
  if (!existsSync(netlogPath)) return { urlRequestCount: 0, canaryHits: 0, error: "netlog missing" };
  let log;
  try {
    log = JSON.parse(readFileSync(netlogPath, "utf8"));
  } catch {
    return { urlRequestCount: 0, canaryHits: 0, error: "netlog is not valid JSON" };
  }
  const constants = log.constants ?? {};
  const eventTypes = constants.logEventTypes ?? {};
  const byId = {};
  for (const name of Object.keys(eventTypes)) byId[eventTypes[name]] = name;
  const events = Array.isArray(log.events) ? log.events : [];
  const urlRequests = events.filter((event) => {
    const name = byId[event.type];
    return typeof name === "string" && name.includes("URL_REQUEST");
  });
  const canaryHits = events.filter((event) => JSON.stringify(event.params ?? {}).includes("canary.invalid")).length;
  return { urlRequestCount: urlRequests.length, canaryHits, error: null };
}

/** Element-serialized evidence only: the raw SCRIPT-RAN / ONERROR-RAN strings
 * also live in the source text of the wrapped body, so match the serialized
 * <title> element and the <body> background style, never plain substrings. */
function analyzeDom(dom) {
  return {
    scriptRan: /<title>\s*SCRIPT-RAN/.test(dom),
    onerrorRan: /<title>\s*ONERROR-RAN/.test(dom),
    redBackground: /<body[^>]*style="[^"]*background[^"]*red/i.test(dom),
  };
}

function fmtStats(name, stats) {
  return `  ${name}: URL_REQUEST events=${stats.urlRequestCount}  canary.invalid hits=${stats.canaryHits}`;
}

function main() {
  const workDir = mkdtempSync(join(tmpdir(), "ai-html-canary-"));
  let pass = true;
  const failures = [];
  const contexts = [];
  try {
    const browser = resolveBrowser();
    console.log(`browser: ${browser}`);
    const harnessPath = join(workDir, "ai-html-canary.html");
    const wrappedPath = join(workDir, "ai-html-canary-wrapped.html");

    // 1. Regenerate the harness through vitest so the payload cannot drift from
    //    the buildSafeHtmlPreview implementation.
    console.log("regenerating harness via vitest …");
    runVitestHarness(harnessPath);
    const harness = readFileSync(harnessPath, "utf8");
    const wrappedPayload = extractWrappedPayload(harness);
    writeFileSync(wrappedPath, wrappedPayload, "utf8");
    console.log(`  harness: ${harnessPath}`);
    console.log(`  wrapped payload: ${wrappedPath} (${wrappedPayload.length} bytes)`);

    // 2. Two independent headless runs, one per context, each with its own
    //    profile (the previous context's origin must not leak into the next).
    const runs = [
      { key: "A", file: harnessPath },
      { key: "B", file: wrappedPath },
    ];
    for (const run of runs) {
      const userDataDir = join(workDir, `profile-${run.key}`);
      const netlogPath = join(workDir, `netlog-${run.key}.json`);
      console.log(`running context ${run.key} (${run.file}) …`);
      const { dom } = runHeadless(browser, run.file, userDataDir, netlogPath);
      const netlogStats = analyzeNetlog(netlogPath);
      contexts.push({ key: run.key, netlogPath, dumpPath: `${netlogPath}.dom.html`, netlogStats, domStats: analyzeDom(dom), dom });
    }

    // 3. Assert every context independently.
    for (const ctx of contexts) {
      console.log(fmtStats(`context ${ctx.key}`, ctx.netlogStats));
      const label = `context ${ctx.key}`;
      if (ctx.netlogStats.error) {
        pass = false;
        failures.push(`${label}: ${ctx.netlogStats.error}`);
      } else {
        if (ctx.netlogStats.urlRequestCount === 0) {
          pass = false;
          failures.push(`${label}: netlog has no URL_REQUEST events (capture failed; cannot prove absence)`);
        }
        if (ctx.netlogStats.canaryHits > 0) {
          pass = false;
          failures.push(`${label}: netlog contains ${ctx.netlogStats.canaryHits} request(s) to canary.invalid`);
        }
      }
      if (ctx.domStats.scriptRan) {
        pass = false;
        failures.push(`${label}: script executed — <title>SCRIPT-RAN</title> present in DOM`);
      }
      if (ctx.domStats.onerrorRan) {
        pass = false;
        failures.push(`${label}: onerror script executed — <title>ONERROR-RAN</title> present in DOM`);
      }
      if (ctx.domStats.redBackground) {
        pass = false;
        failures.push(`${label}: script executed — red body background in DOM`);
      }
    }

    // 4. Context A additionally proves the iframe carries the sandbox attribute.
    const contextA = contexts.find((ctx) => ctx.key === "A");
    if (contextA && !/<iframe[^>]*\ssandbox(\s|$|=)/i.test(contextA.dom)) {
      pass = false;
      failures.push("context A: preview iframe is missing the sandbox attribute in the DOM");
    }
  } finally {
    if (!process.env.AI_HTML_CANARY_KEEP_TMP) rmSync(workDir, { recursive: true, force: true });
    else console.log(`artifacts kept in ${workDir}`);
  }

  console.log(pass ? "PASS" : "FAIL");
  if (failures.length > 0) {
    console.error(failures.map((failure) => `- ${failure}`).join("\n"));
    process.exitCode = 1;
  }
}

main();
