import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assembleCustomBundle,
  buildCustomBundleOptions,
  buildSqliteWorkerOptions,
  buildStoredZipParts,
  cnbMirrorUrl,
  computeBundlePlan,
  crc32,
  extractDriverPackage,
  parseTarEntries,
  proxyUrl,
  resolveBundleJre,
  type BundleFetch,
  type BundleProgress,
} from "./agentBundle";
import type { AgentRegistry } from "./agentRegistry";

// One real zstd-compressed tar package per artifact kind, generated from the
// same packaging pipeline the agents release uses: agent-registry.json plus a
// single drivers/<raw artifact> entry whose sha256/size live in the package
// registry.
const H2_PACKAGE_B64 =
  "KLUv/WQAJ+UIANLPMR5Abx4MRfRiaicr9JyLFkQ+oPd7okg66hWu3jEMvzJUQUDQQoJggC69cU2gMs45/RfsImTnS3ntYEKoNtdhe9Y+T5zT+oxSygeSgxkvdPhYaO8377m7rfHb6Qi9MqZeLOCMQMXePMm10eunqEJO3894EvlMaVSl/JLK92rnq5uGRdYoBFKphB292g/R2xr16sYac+209MDO6PwUnG+vDMbp6XOjMao1latkmqgGUFJC55RrrzX1XmxKekwNZsmSCS8+ByTSL2ogIKBI5OZiDvEB4gGBM0YluJsxQKawR+ruyWIPqAuBfwjWTQIMguX/ukuazBE4rMCIDSoGgHXg1Ns/gAgRNscABWE+lARNsumy9UL2QQWYRssdLqm+fQ==";
const WORKER_X64_PACKAGE_B64 =
  "KLUv/WQAJ8UJANaQOBUg33aNNeLmwGRzcMD4KmOEEQQQxJAyADIAMgAu3N8/m6/YhRx/Ovzfs+OAYQDvF8MyYATAYvjjSBTDABTFG8DKwidhvzFskv8d4vWTX7MZf2sX+oEI3UgI77Xt562m2gUukDQt+LFZYVr6wS/tQvfEQRj96Strvh99WXr4sZkGywebD0TGBFkQ0DfjqIiHgTTJT3zogAbIKIwSNk1/ul+Qr4S7MAxDDYqvrPh6qOXVTH+A5ym+87rNmirPmiAvi6js4pgE8R4xCiBHkKf/22SaDzJJMvpECQ/FGZMvdBrvQyUgIIBmAkXcHM0D8m1MlbhuZICcgByVu8cNsNLFxssT9tBZEXR7j3YCKBmiERgujoFLQ5ARlKwcyUM6QnBhUaEAQZgzJQEn2fX6G1zINqgA06i7A1oXEpU=";
const WORKER_ARM_PACKAGE_B64 =
  "KLUv/WQAJ/0JAMYQOSAQlR5qET7YNofHkpdFP5XGZR5I2104afgPlBQBAADgMi4AMAAuAB2u839wvj2VSIPmPmOa9Nxfth3neQ541CmE0v1JSf1tGw5TiXLHYctnqtveYgNaZ7eeGsapXVBRjMOx2IY1PUkACAgE8B1eOCDaZ1brqWkFK+9BbxucP5M3IOo7rAWxTgj9wphN/ylnlNS6pL0yt65bQbzZV65I6Yz2wvVEUVQou9kj6YWSraVCng0HT1KE4UEgYJMII7HAGIkC9jgoHg0JlF5d4IFXknHQP8I/45XZvG6t9StWfHtZkVKrDCIggGYCrNockQfkx5hqdt34AIkCbmTuHjewShcbAw+sowlEzFIMLdyknUBKQzwFBvESBBqABRBkBSWbI+khHSH4sOhQgCDMj5KAkyx4fW8NyDJoANOougOGR+RC";

const H2_JAR_BYTES = new TextEncoder().encode("FAKE_JAR_00");
const WORKER_X64_BYTES = new TextEncoder().encode("WORKER_BIN_LINUX_X64__");
const WORKER_ARM_BYTES = new TextEncoder().encode("WORKER_BIN_LINUX_AARCH64");
const JRE_BYTES = new TextEncoder().encode("FAKE_JRE_TAR_ZST_BYTES");
const JRE_SHA256 = "6529fca7c62b0e7b0ecf1afe8fe75a924897c30dda8f7e5862677a59bcf68aa0";

function decodeB64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const RELEASE = "https://github.com/t8y2/dbx/releases/download/agents-v9.9.9";

const h2Package = decodeB64(H2_PACKAGE_B64);
const workerX64Package = decodeB64(WORKER_X64_PACKAGE_B64);
const workerArmPackage = decodeB64(WORKER_ARM_PACKAGE_B64);

const testRegistry: AgentRegistry = {
  jres: {
    "21": {
      version: "21",
      platforms: {
        "windows-x64": { url: `${RELEASE}/dbx-jre-21-windows-x64.tar.zst`, sha256: JRE_SHA256, size: JRE_BYTES.length, format: "tar_zstd" },
        "macos-aarch64": { url: `${RELEASE}/dbx-jre-21-macos-aarch64.tar.zst`, sha256: "0".repeat(64), size: 5, format: "tar_zstd" },
      },
    },
  },
  drivers: {
    h2: {
      version: "1.0.0",
      label: "H2",
      min_app_version: "0.6.33",
      jre: "21",
      jar: { url: `${RELEASE}/dbx-agent-h2-1.0.0.tar.zst`, sha256: await sha256Hex(h2Package), size: h2Package.length, format: "tar_zstd" },
    },
    duckdb: {
      version: "0.1.29",
      label: "DuckDB",
      min_app_version: "0.6.33",
      jre: "21",
      native: {
        "windows-x64": { url: `${RELEASE}/dbx-agent-duckdb-0.1.29-windows-x64.tar.zst`, sha256: "1".repeat(64), size: 100, format: "tar_zstd" },
        "macos-aarch64": { url: `${RELEASE}/dbx-agent-duckdb-0.1.29-macos-aarch64.tar.zst`, sha256: "2".repeat(64), size: 90, format: "tar_zstd" },
      },
    },
    "sqlite-worker": {
      version: "0.1.6",
      label: "SQLite SSH Worker",
      min_app_version: "0.6.30",
      jre: "21",
      native: {
        "linux-x64": { url: `${RELEASE}/dbx-agent-sqlite-worker-0.1.6-linux-x64.tar.zst`, sha256: await sha256Hex(workerX64Package), size: workerX64Package.length, format: "tar_zstd" },
        "linux-aarch64": { url: `${RELEASE}/dbx-agent-sqlite-worker-0.1.6-linux-aarch64.tar.zst`, sha256: await sha256Hex(workerArmPackage), size: workerArmPackage.length, format: "tar_zstd" },
      },
    },
  },
};

test("crc32 matches the canonical check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

function tarEntry(name: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode(name), 0);
  header.set(new TextEncoder().encode(data.length.toString(8).padStart(11, "0") + "\0"), 124);
  header[156] = 48;
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data, 0);
  const entry = new Uint8Array(512 + padded.length);
  entry.set(header, 0);
  entry.set(padded, 512);
  return entry;
}

test("tar entries round-trip through the parser", () => {
  const registry = new TextEncoder().encode('{"drivers":{}}');
  const bin = new Uint8Array(600).fill(7);
  const parts = [tarEntry("agent-registry.json", registry), tarEntry("drivers/agent.bin", bin), new Uint8Array(1024)];
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }

  const entries = parseTarEntries(bytes);
  assert.deepEqual([...entries.keys()], ["agent-registry.json", "drivers/agent.bin"]);
  assert.equal(new TextDecoder().decode(entries.get("agent-registry.json")!), '{"drivers":{}}');
  const parsedBin = entries.get("drivers/agent.bin")!;
  assert.equal(parsedBin.length, 600);
  assert.ok(parsedBin.every((byte) => byte === 7));
});

interface ParsedZipEntry {
  name: string;
  data: Uint8Array;
  method: number;
  crc: number;
}

function readStoredZip(bytes: Uint8Array): ParsedZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: ParsedZipEntry[] = [];
  const expectedOffsets: number[] = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const crc = view.getUint32(offset + 14, true);
    const size = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const dataStart = offset + 30 + nameLength + extraLength;
    entries.push({ name, data: bytes.subarray(dataStart, dataStart + size), method, crc });
    expectedOffsets.push(offset);
    offset = dataStart + size;
  }
  const dataEnd = offset;
  // The central directory follows the file data; every record must mirror the
  // local header it describes and the EOCD counts must match.
  let centralCount = 0;
  while (view.getUint32(offset, true) === 0x02014b50) {
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    assert.equal(view.getUint16(offset + 10, true), 0, "central directory entry must be STORED");
    const entry = entries[centralCount];
    assert.ok(entry, `central directory has more entries than local headers: #${centralCount}`);
    assert.equal(new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)), entry.name);
    assert.equal(view.getUint32(offset + 16, true), entry.crc);
    assert.equal(view.getUint32(offset + 20, true), entry.data.length);
    assert.equal(localOffset, expectedOffsets[centralCount]);
    centralCount += 1;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  const centralEnd = offset;
  assert.equal(view.getUint32(offset, true), 0x06054b50);
  assert.equal(view.getUint16(offset + 8, true), entries.length);
  assert.equal(view.getUint16(offset + 10, true), centralCount);
  assert.equal(view.getUint32(offset + 12, true), centralEnd - dataEnd);
  assert.equal(view.getUint32(offset + 16, true), dataEnd);
  assert.equal(bytes.length, offset + 22);
  return entries;
}

test("stored zip parts assemble a valid zip32 archive", async () => {
  const first = new TextEncoder().encode("agent-registry.json content");
  const second = new Uint8Array(1000).fill(9);
  const result = buildStoredZipParts([
    { name: "agent-registry.json", data: first },
    { name: "drivers/dbx-agent.bin", data: second },
  ], new Date(2026, 9, 4, 12, 30, 22));

  assert.equal(result.totalSize, (30 + 19) + 27 + (30 + 21) + 1000 + (46 + 19) + (46 + 21) + 22);
  const blob = new Blob(result.parts);
  const entries = readStoredZip(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["agent-registry.json", "drivers/dbx-agent.bin"],
  );
  assert.ok(entries.every((entry) => entry.method === 0));
  assert.deepEqual([...entries[0]!.data], [...first]);
  assert.ok(entries[1]!.data.every((byte) => byte === 9));
  assert.equal(entries[0]!.crc, crc32(first));

  assert.throws(() => buildStoredZipParts([]), /at least one file/);
  assert.throws(() => buildStoredZipParts([{ name: "é.bin", data: first }]), /ASCII/);
});

test("driver packages unpack their raw artifact and offline registry entry", () => {
  const extracted = extractDriverPackage(h2Package, "h2");
  assert.equal(extracted.artifactKind, "jar");
  assert.equal(extracted.filename, "dbx-agent-h2-1.0.0.jar");
  assert.deepEqual([...extracted.bytes], [...H2_JAR_BYTES]);
  assert.equal(extracted.entry.label, "H2");
  assert.equal(extracted.entry.min_app_version, "0.6.33");
  assert.equal(extracted.entry.jar?.url, "offline://dbx-agent-h2-1.0.0.jar");
  assert.equal(extracted.entry.jar?.size, H2_JAR_BYTES.length);
  assert.ok(extracted.entry.jar?.sha256);

  const worker = extractDriverPackage(workerX64Package, "sqlite-worker");
  assert.equal(worker.artifactKind, "native");
  assert.deepEqual(worker.nativePlatforms, ["linux-x64"]);
  assert.equal(worker.filename, "dbx-agent-sqlite-worker-0.1.6-linux-x64");
  assert.deepEqual([...worker.bytes], [...WORKER_X64_BYTES]);
  assert.equal(worker.entry.native?.["linux-x64"]?.url, "offline://dbx-agent-sqlite-worker-0.1.6-linux-x64");

  assert.throws(() => extractDriverPackage(h2Package, "duckdb"), /exactly the "duckdb"/);
});

test("bundle options follow native-over-jar and platform availability", () => {
  const windows = buildCustomBundleOptions(testRegistry, "windows-x64");
  assert.deepEqual(windows.map((option) => option.key), ["duckdb", "h2"]);
  assert.equal(windows.find((option) => option.key === "duckdb")?.kind, "native");
  assert.equal(windows.find((option) => option.key === "h2")?.kind, "jar");
  assert.equal(windows.find((option) => option.key === "h2")?.requiresJre, true);
  assert.equal(windows.find((option) => option.key === "duckdb")?.requiresJre, false);

  const workers = buildSqliteWorkerOptions(testRegistry, "windows-x64");
  assert.equal(workers.length, 2);
  assert.deepEqual(
    workers.map((worker) => worker.packageUrl.split("/").pop()),
    ["dbx-agent-sqlite-worker-0.1.6-linux-x64.tar.zst", "dbx-agent-sqlite-worker-0.1.6-linux-aarch64.tar.zst"],
  );

  const jre = resolveBundleJre(testRegistry, "windows-x64");
  assert.equal(jre?.filename, "dbx-jre-21-windows-x64.tar.zst");
  assert.equal(jre?.sha256, JRE_SHA256);
});

test("bundle plans force the JRE for Java agents and always bundle SSH workers", () => {
  const jarPlan = computeBundlePlan(testRegistry, "windows-x64", new Set(["h2"]), false);
  assert.equal(jarPlan.requiresJre, true);
  assert.equal(jarPlan.includeJre, true);
  assert.ok(jarPlan.jre);
  assert.deepEqual(
    jarPlan.drivers.map((driver) => driver.key),
    ["h2"],
  );
  assert.equal(jarPlan.workers.length, 2);
  assert.equal(jarPlan.totalDownloadBytes, h2Package.length + workerX64Package.length + workerArmPackage.length + JRE_BYTES.length);
  assert.equal(jarPlan.filename, "dbx-agents-offline-custom-windows-x64.zip");

  const nativePlan = computeBundlePlan(testRegistry, "windows-x64", new Set(["duckdb"]), true);
  assert.equal(nativePlan.requiresJre, false);
  assert.equal(nativePlan.includeJre, true);
  assert.ok(nativePlan.jre);

  const nativeOnly = computeBundlePlan(testRegistry, "windows-x64", new Set(["duckdb"]), false);
  assert.equal(nativeOnly.includeJre, false);
  assert.equal(nativeOnly.jre, null);
  assert.equal(nativeOnly.totalDownloadBytes, 100 + workerX64Package.length + workerArmPackage.length);
});

test("assemble builds a driver-manager compatible offline ZIP end to end", async () => {
  const plan = computeBundlePlan(testRegistry, "windows-x64", new Set(["h2"]), false);
  const fetched: string[] = [];
  const fetchPackage: BundleFetch = async (url) => {
    fetched.push(url);
    if (url.endsWith("dbx-agent-h2-1.0.0.tar.zst")) return h2Package;
    if (url.endsWith("dbx-agent-sqlite-worker-0.1.6-linux-x64.tar.zst")) return workerX64Package;
    if (url.endsWith("dbx-agent-sqlite-worker-0.1.6-linux-aarch64.tar.zst")) return workerArmPackage;
    if (url.endsWith("dbx-jre-21-windows-x64.tar.zst")) return JRE_BYTES;
    throw new Error(`unexpected url ${url}`);
  };
  const progress: BundleProgress[] = [];
  const signal = new AbortController().signal;

  const assembled = await assembleCustomBundle(plan, fetchPackage, (event) => progress.push(event), signal);

  assert.equal(assembled.filename, "dbx-agents-offline-custom-windows-x64.zip");
  assert.ok(progress.some((event) => event.phase === "download" && event.label === "H2"));
  assert.ok(progress.some((event) => event.phase === "unpack"));
  assert.ok(progress.some((event) => event.phase === "assemble"));
  assert.ok(progress.some((event) => event.phase === "done"));

  const bytes = new Uint8Array(await assembled.blob.arrayBuffer());
  const entries = readStoredZip(bytes);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["agent-registry.json", "drivers/dbx-agent-h2-1.0.0.jar", "drivers/dbx-agent-sqlite-worker-0.1.6-linux-x64", "drivers/dbx-agent-sqlite-worker-0.1.6-linux-aarch64", "jre/dbx-jre-21-windows-x64.tar.zst"],
  );
  assert.deepEqual([...entries[1]!.data], [...H2_JAR_BYTES]);
  assert.deepEqual([...entries[2]!.data], [...WORKER_X64_BYTES]);
  assert.deepEqual([...entries[4]!.data], [...JRE_BYTES]);

  const registry = JSON.parse(new TextDecoder().decode(entries[0]!.data)) as {
    jres: Record<string, { version: string; platforms: Record<string, { url: string; sha256?: string; size: number; format: string }> }>;
    drivers: Record<string, Record<string, unknown> & { jar?: { url: string; size: number }; native?: Record<string, { url: string }> }>;
  };
  assert.deepEqual(Object.keys(registry.jres), ["21"]);
  const jreEntry = registry.jres["21"]!.platforms["windows-x64"]!;
  assert.equal(jreEntry.url, "offline://dbx-jre-21-windows-x64.tar.zst");
  assert.equal(jreEntry.sha256, JRE_SHA256);
  assert.equal(jreEntry.size, JRE_BYTES.length);
  assert.equal(jreEntry.format, "tar_zstd");
  assert.equal(registry.drivers.h2!.jar!.url, "offline://dbx-agent-h2-1.0.0.jar");
  assert.equal(registry.drivers.h2!.min_app_version, "0.6.33");
  assert.equal(registry.drivers.h2!.label, "H2");
  assert.deepEqual(Object.keys(registry.drivers["sqlite-worker"]!.native!), ["linux-x64", "linux-aarch64"]);
  assert.equal(fetched.length, 4);
});

test("assembly rejects packages whose checksum does not match the registry", async () => {
  const corrupted: AgentRegistry = JSON.parse(JSON.stringify(testRegistry));
  corrupted.drivers!.h2!.jar!.sha256 = "f".repeat(64);
  const plan = computeBundlePlan(corrupted, "windows-x64", new Set(["h2"]), false);
  const fetchPackage: BundleFetch = async (url) => (url.endsWith("h2-1.0.0.tar.zst") ? h2Package : url.endsWith("linux-x64.tar.zst") ? workerX64Package : url.endsWith("linux-aarch64.tar.zst") ? workerArmPackage : JRE_BYTES);
  await assert.rejects(
    assembleCustomBundle(plan, fetchPackage, () => {}, new AbortController().signal),
    /checksum mismatch/i,
  );
});

test("mirror and proxy URLs map GitHub assets to their alternates", () => {
  assert.equal(cnbMirrorUrl(`${RELEASE}/dbx-agent-h2-1.0.0.tar.zst`), `https://cnb.cool/dbxio.com/dbx/-/releases/download/agents-v9.9.9/dbx-agent-h2-1.0.0.tar.zst`);
  assert.equal(
    proxyUrl("https://dbxio.com", `${RELEASE}/dbx-agent-h2-1.0.0.tar.zst`),
    `https://dbxio.com/api/agent-asset?url=${encodeURIComponent(`${RELEASE}/dbx-agent-h2-1.0.0.tar.zst`)}`,
  );
});
