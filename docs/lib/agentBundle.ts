import { decompress } from "fzstd";
import { labelForDriver, platformLabels, type AgentRegistry, type AgentRegistryArtifact, type AgentRegistryDriver } from "./agentRegistry";

/**
 * Custom offline bundle builder.
 *
 * The website assembles a driver-manager-compatible ZIP (`agent-registry.json`
 * + `drivers/` + `jre/`) entirely in the browser:
 *
 * 1. The agent registry exposes every driver as a `.tar.zst` *package* that
 *    wraps the raw artifact (a Java agent JAR or a native executable) plus a
 *    single-driver `agent-registry.json` with the raw artifact's authoritative
 *    SHA-256 and size.
 * 2. Each selected package is downloaded, decompressed, and unpacked in the
 *    browser; the raw artifact is stored verbatim while the package registry
 *    provides the metadata for the synthesized bundle registry.
 * 3. The bundle is a STORED (uncompressed) ZIP — the desktop offline import
 *    (`collect_offline_entries`) matches entries by filename against
 *    `offline://<filename>` registry URLs and validates size/SHA-256, so raw
 *    artifacts must be embedded byte-for-byte.
 *
 * The SQLite SSH worker binaries execute on the remote SSH host, so the Linux
 * packages must ship in every bundle regardless of the chosen platform (#8987).
 */

export const SQLITE_WORKER_DRIVER_KEY = "sqlite-worker";
export const SQLITE_WORKER_NATIVE_PLATFORMS = ["linux-x64", "linux-aarch64"] as const;

export const CUSTOM_BUNDLE_PLATFORMS = ["macos-aarch64", "macos-x64", "linux-x64", "linux-aarch64", "windows-x64", "windows-aarch64"] as const;
export type CustomBundlePlatform = (typeof CUSTOM_BUNDLE_PLATFORMS)[number];

const WINDOWS_NATIVE_SUFFIX = ".exe";
const PACKAGE_SUFFIX = ".tar.zst";
/** Hard stop before the zip32 4 GiB ceiling plus header overhead. */
const MAX_BUNDLE_BYTES = 3.5 * 1024 * 1024 * 1024;

export interface CustomBundleDriverOption {
  key: string;
  label: string;
  version: string;
  minAppVersion: string;
  kind: "jar" | "native";
  requiresJre: boolean;
  packageUrl: string;
  packageSha256?: string;
  packageSize: number;
  platformLabel: string;
}

export interface CustomBundleJre {
  key: string;
  version: string;
  platformKey: string;
  url: string;
  sha256?: string;
  size: number;
  filename: string;
}

function filenameFromUrl(url: string): string {
  const bare = url.split("offline://").pop() ?? url;
  return bare.substring(bare.lastIndexOf("/") + 1);
}

function artifactForPlatform(driver: AgentRegistryDriver, platform: string): { kind: "jar" | "native"; artifact: AgentRegistryArtifact } | null {
  const native = driver.native?.[platform];
  if (native?.url && native.size > 0) return { kind: "native", artifact: native };
  if (driver.jar?.url && driver.jar.size > 0) return { kind: "jar", artifact: driver.jar };
  return null;
}

/** Drivers available for a platform, excluding the auto-included SQLite worker. */
export function buildCustomBundleOptions(registry: AgentRegistry, platform: string): CustomBundleDriverOption[] {
  return Object.entries(registry.drivers ?? {})
    .filter(([key]) => key !== SQLITE_WORKER_DRIVER_KEY)
    .flatMap(([key, driver]) => {
      const match = artifactForPlatform(driver, platform);
      if (!match) return [];
      return [
        {
          key,
          label: driver.label ?? labelForDriver(key),
          version: driver.version ?? "",
          minAppVersion: driver.min_app_version ?? "",
          kind: match.kind,
          requiresJre: match.kind === "jar" && !!(driver.jre && driver.jre.trim() !== ""),
          packageUrl: match.artifact.url,
          packageSha256: match.artifact.sha256,
          packageSize: match.artifact.size,
          platformLabel: platformLabels[platform] ?? platform,
        },
      ];
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The SQLite SSH worker packages that every custom bundle must include. */
export function buildSqliteWorkerOptions(registry: AgentRegistry, platform: string): CustomBundleDriverOption[] {
  const driver = registry.drivers?.[SQLITE_WORKER_DRIVER_KEY];
  if (!driver) return [];
  const options: CustomBundleDriverOption[] = [];
  for (const workerPlatform of SQLITE_WORKER_NATIVE_PLATFORMS) {
    const artifact = driver.native?.[workerPlatform];
    if (!artifact?.url || artifact.size <= 0) continue;
    options.push({
      key: SQLITE_WORKER_DRIVER_KEY,
      label: `${driver.label ?? "SQLite SSH Worker"} (${platformLabels[workerPlatform] ?? workerPlatform})`,
      version: driver.version ?? "",
      minAppVersion: driver.min_app_version ?? "",
      kind: "native",
      requiresJre: false,
      packageUrl: artifact.url,
      packageSha256: artifact.sha256,
      packageSize: artifact.size,
      platformLabel: platformLabels[workerPlatform] ?? workerPlatform,
    });
  }
  return options;
}

export function resolveBundleJre(registry: AgentRegistry, platform: string): CustomBundleJre | null {
  for (const [key, jre] of Object.entries(registry.jres ?? {})) {
    const artifact = jre.platforms?.[platform];
    if (!artifact?.url || artifact.size <= 0) continue;
    return {
      key,
      version: jre.version ?? key,
      platformKey: platform,
      url: artifact.url,
      sha256: artifact.sha256,
      size: artifact.size,
      filename: filenameFromUrl(artifact.url),
    };
  }
  return null;
}

export interface BundlePlan {
  platform: string;
  drivers: CustomBundleDriverOption[];
  workers: CustomBundleDriverOption[];
  jre: CustomBundleJre | null;
  requiresJre: boolean;
  includeJre: boolean;
  totalDownloadBytes: number;
  filename: string;
}

export function computeBundlePlan(registry: AgentRegistry, platform: string, selectedKeys: ReadonlySet<string>, includeJre: boolean): BundlePlan {
  const options = buildCustomBundleOptions(registry, platform);
  const drivers = options.filter((option) => selectedKeys.has(option.key));
  const workers = buildSqliteWorkerOptions(registry, platform);
  const jre = resolveBundleJre(registry, platform);
  const requiresJre = drivers.some((option) => option.requiresJre);
  const effectiveIncludeJre = includeJre || requiresJre;
  const items = [...drivers, ...workers];
  const totalDownloadBytes = items.reduce((sum, item) => sum + item.packageSize, 0) + (effectiveIncludeJre && jre ? jre.size : 0);
  return {
    platform,
    drivers,
    workers,
    jre: effectiveIncludeJre ? jre : null,
    requiresJre,
    includeJre: effectiveIncludeJre,
    totalDownloadBytes,
    filename: `dbx-agents-offline-custom-${platform}.zip`,
  };
}

interface PackageDriverEntry {
  version: string;
  label?: string;
  min_app_version: string;
  jre?: string;
  jar?: { url: string; sha256?: string; size: number };
  native?: Record<string, { url: string; sha256?: string; size: number }>;
  [field: string]: unknown;
}

export interface ExtractedDriverPackage {
  driverKey: string;
  entry: PackageDriverEntry;
  artifactKind: "jar" | "native";
  nativePlatforms: string[];
  filename: string;
  bytes: Uint8Array;
  sha256?: string;
}

function octal(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) {
    if (byte === 0 || byte === 32) break;
    if (byte < 48 || byte > 55) throw new Error("Invalid tar size field");
    value = value * 8 + (byte - 48);
  }
  return value;
}

/** Minimal ustar tar reader for driver packages (regular files only). */
export function parseTarEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = String.fromCharCode(...header.subarray(0, 100)).replace(/\0.*$/, "");
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) throw new Error(`Truncated tar entry: ${rawName}`);
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === "L") {
      longName = new TextDecoder().decode(data.subarray(0, data.indexOf(0) === -1 ? data.length : data.indexOf(0)));
    } else if (type === "0" || type === "\0") {
      let name = longName ?? rawName;
      longName = null;
      const magic = String.fromCharCode(...header.subarray(257, 262));
      if (magic === "ustar") {
        const prefix = String.fromCharCode(...header.subarray(345, 500)).replace(/\0.*$/, "");
        if (prefix) name = `${prefix}/${name}`;
      }
      if (name) entries.set(name, data);
    } else if (type !== "5" && type !== "x" && type !== "g") {
      throw new Error(`Unsupported tar entry type "${type}": ${rawName}`);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/**
 * Unpacks a downloaded `.tar.zst` driver package and returns the raw artifact
 * plus its package registry entry with the artifact URL rewritten to the
 * `offline://` form the desktop offline import matches on.
 */
export function extractDriverPackage(packageBytes: Uint8Array, expectedKey: string): ExtractedDriverPackage {
  const tarEntries = parseTarEntries(decompress(packageBytes));
  const registryRaw = tarEntries.get("agent-registry.json");
  if (!registryRaw) throw new Error("Driver package is missing agent-registry.json");
  const packageRegistry = JSON.parse(new TextDecoder().decode(registryRaw)) as { drivers?: Record<string, PackageDriverEntry> };
  const drivers = packageRegistry.drivers ?? {};
  if (Object.keys(drivers).length !== 1 || !(expectedKey in drivers)) {
    throw new Error(`Driver package registry does not describe exactly the "${expectedKey}" driver`);
  }
  const entry = drivers[expectedKey];
  const rewrite = (artifact: { url: string; sha256?: string; size: number }) => {
    const filename = filenameFromUrl(artifact.url);
    if (!filename) throw new Error(`Driver package artifact has no filename: ${artifact.url}`);
    return { url: `offline://${filename}`, ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}), size: artifact.size };
  };

  if (entry.jar && !entry.native) {
    const filename = filenameFromUrl(entry.jar.url);
    const bytes = tarEntries.get(`drivers/${filename}`);
    if (!bytes) throw new Error(`Driver package is missing drivers/${filename}`);
    if (entry.jar.size > 0 && bytes.length !== entry.jar.size) throw new Error(`Driver package artifact size mismatch for ${filename}`);
    return {
      driverKey: expectedKey,
      entry: { ...entry, jar: rewrite(entry.jar) },
      artifactKind: "jar",
      nativePlatforms: [],
      filename,
      bytes,
      sha256: entry.jar.sha256,
    };
  }
  if (entry.native && Object.keys(entry.native).length === 1 && !entry.jar) {
    const [platform, artifact] = Object.entries(entry.native)[0]!;
    const platformFilename = filenameFromUrl(artifact.url);
    const platformBytes = tarEntries.get(`drivers/${platformFilename}`);
    if (!platformBytes) throw new Error(`Driver package is missing drivers/${platformFilename}`);
    if (artifact.size > 0 && platformBytes.length !== artifact.size) throw new Error(`Driver package artifact size mismatch for ${platformFilename}`);
    return {
      driverKey: expectedKey,
      entry: { ...entry, native: { [platform]: rewrite(artifact) } },
      artifactKind: "native",
      nativePlatforms: [platform],
      filename: platformFilename,
      bytes: platformBytes,
      sha256: artifact.sha256,
    };
  }
  throw new Error(`Driver package for "${expectedKey}" must contain exactly one artifact`);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface StoredZipEntry {
  name: string;
  data: Uint8Array;
}

export interface StoredZipResult {
  parts: BlobPart[];
  totalSize: number;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >>> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Builds a STORED (uncompressed) zip32 archive as Blob parts. Sizes and CRCs
 * are known upfront, so entries need no data descriptors and the central
 * directory is written after all file data.
 */
export function buildStoredZipParts(entries: StoredZipEntry[], date = new Date()): StoredZipResult {
  if (entries.length === 0) throw new Error("A custom bundle needs at least one file");
  if (entries.length > 0xffff) throw new Error("Too many bundle entries for a zip32 archive");
  const names = entries.map((entry) => new TextEncoder().encode(entry.name));
  for (const name of names) {
    if (name.length === 0 || name.length > 0xffff || name.some((byte) => byte > 0x7f)) {
      throw new Error("Bundle entry names must be non-empty ASCII");
    }
  }
  const { time, date: dosDate } = dosDateTime(date);
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let centralSize = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const name = names[index];
    const crc = crc32(entries[index].data);
    const size = entries[index].data.length;
    if (offset + size > 0xffffffff) throw new Error("Bundle exceeds the 4 GiB zip32 limit");

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, size, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);
    parts.push(local, entries[index].data as unknown as BlobPart);

    const centralEntry = new Uint8Array(46 + name.length);
    const centralView = new DataView(centralEntry.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, size, true);
    centralView.setUint32(24, size, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralEntry.set(name, 46);
    central.push(centralEntry);
    centralSize += centralEntry.length;
    offset += local.length + size;
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);
  parts.push(...(central as unknown as BlobPart[]), eocd);
  return { parts, totalSize: offset + centralSize + 22 };
}

export type BundleFetch = (url: string, onProgress: (received: number) => void, signal: AbortSignal) => Promise<Uint8Array>;

export type BundleProgress =
  | { phase: "download"; completed: number; total: number; receivedBytes: number; totalBytes: number }
  | { phase: "assemble" }
  | { phase: "done"; filename: string; size: number };

export interface AssembleResult {
  blob: Blob;
  filename: string;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Parallel package downloads; 4 keeps the peak heap bounded by a few packages. */
export const BUNDLE_DOWNLOAD_CONCURRENCY = 4;

async function runPool(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let cursor = 0;
  const failure: { current: { error: unknown } | null } = { current: null };
  const worker = async () => {
    for (;;) {
      if (failure.current) return;
      const index = cursor++;
      if (index >= tasks.length) return;
      try {
        await tasks[index]!();
      } catch (error) {
        failure.current ??= { error };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  if (failure.current) throw failure.current.error;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeDriverEntry(target: Record<string, PackageDriverEntry>, extracted: ExtractedDriverPackage): void {
  const existing = target[extracted.driverKey];
  if (!existing) {
    target[extracted.driverKey] = extracted.entry;
    return;
  }
  // The SQLite worker ships one package per remote platform; merge their
  // native maps into a single registry entry.
  if (existing.native && extracted.entry.native) {
    target[extracted.driverKey] = { ...existing, native: { ...existing.native, ...extracted.entry.native } };
    return;
  }
  throw new Error(`Duplicate driver package for "${extracted.driverKey}"`);
}

/**
 * Downloads the planned packages in parallel (CNB first with a silent fallback
 * handled by the injected `fetchPackage`), unpacks and verifies each raw
 * artifact, then assembles the driver-manager compatible ZIP. The first
 * failing package stops the pool; in-flight downloads still settle.
 */
export async function assembleCustomBundle(
  plan: BundlePlan,
  fetchPackage: BundleFetch,
  onProgress: (progress: BundleProgress) => void,
  signal: AbortSignal,
  deps: { sha256?: (bytes: Uint8Array) => Promise<string> } = {},
): Promise<AssembleResult> {
  if (plan.drivers.length === 0) throw new Error("Select at least one driver");
  const hash = deps.sha256 ?? sha256Hex;
  const items = [...plan.drivers, ...plan.workers];
  const jre = plan.jre;
  const total = items.length + (jre ? 1 : 0);
  const totalBytes = items.reduce((sum, item) => sum + item.packageSize, 0) + (jre?.size ?? 0);
  const extractedByUrl = new Map<string, ExtractedDriverPackage>();
  const receivedByUrl = new Map<string, number>();
  const jreResult: { bytes: Uint8Array | null } = { bytes: null };
  let completed = 0;

  const reportDownload = () => {
    let receivedBytes = 0;
    for (const value of receivedByUrl.values()) receivedBytes += value;
    onProgress({ phase: "download", completed, total, receivedBytes, totalBytes });
  };

  const downloadOne = async (url: string, expectedBytes: number): Promise<Uint8Array> => {
    const bytes = await fetchPackage(
      url,
      (received) => {
        receivedByUrl.set(url, received);
        reportDownload();
      },
      signal,
    );
    receivedByUrl.set(url, bytes.length);
    return bytes;
  };

  const tasks: Array<() => Promise<void>> = items.map((item) => async () => {
    signal.throwIfAborted();
    let packageBytes: Uint8Array;
    try {
      packageBytes = await downloadOne(item.packageUrl, item.packageSize);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(`${item.label} — ${describe(error)}`);
    }
    if (item.packageSha256) {
      const actual = await hash(packageBytes);
      if (actual !== item.packageSha256.toLowerCase()) throw new Error(`${item.label} — package checksum mismatch`);
    }
    let extracted: ExtractedDriverPackage;
    try {
      extracted = extractDriverPackage(packageBytes, item.key);
    } catch (error) {
      throw new Error(`${item.label} — ${describe(error)}`);
    }
    if (extracted.artifactKind !== item.kind) throw new Error(`${item.label} — package kind mismatch: expected ${item.kind}`);
    if (extracted.sha256) {
      const actual = await hash(extracted.bytes);
      if (actual !== extracted.sha256.toLowerCase()) throw new Error(`${item.label} — artifact checksum mismatch`);
    }
    extractedByUrl.set(item.packageUrl, extracted);
    completed += 1;
    reportDownload();
  });
  if (jre) {
    tasks.push(async () => {
      signal.throwIfAborted();
      let bytes: Uint8Array;
      try {
        bytes = await downloadOne(jre.url, jre.size);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(`JRE ${jre.key} — ${describe(error)}`);
      }
      if (jre.sha256) {
        const actual = await hash(bytes);
        if (actual !== jre.sha256.toLowerCase()) throw new Error(`JRE ${jre.key} — checksum mismatch`);
      }
      jreResult.bytes = bytes;
      completed += 1;
      reportDownload();
    });
  }

  await runPool(tasks, BUNDLE_DOWNLOAD_CONCURRENCY);

  const drivers: Record<string, PackageDriverEntry> = {};
  const zipEntries: StoredZipEntry[] = [];
  let rawBytes = 0;
  for (const item of items) {
    const extracted = extractedByUrl.get(item.packageUrl);
    if (!extracted) throw new Error(`${item.label} — package was not downloaded`);
    mergeDriverEntry(drivers, extracted);
    zipEntries.push({ name: `drivers/${extracted.filename}`, data: extracted.bytes });
    rawBytes += extracted.bytes.length;
  }

  let jres: Record<string, { version: string; platforms: Record<string, { url: string; sha256?: string; size: number; format: "tar_zstd" }> }> = {};
  const jreBytes = jreResult.bytes;
  if (jre && jreBytes) {
    jres = {
      [jre.key]: {
        version: jre.version,
        platforms: {
          [jre.platformKey]: { url: `offline://${jre.filename}`, ...(jre.sha256 ? { sha256: jre.sha256 } : {}), size: jre.size, format: "tar_zstd" },
        },
      },
    };
    zipEntries.push({ name: `jre/${jre.filename}`, data: jreBytes });
    rawBytes += jreBytes.length;
  }
  if (rawBytes > MAX_BUNDLE_BYTES) throw new Error("Selection exceeds the maximum custom bundle size (3.5 GB)");

  onProgress({ phase: "assemble" });
  const registryJson = new TextEncoder().encode(JSON.stringify({ jres, drivers }));
  const result = buildStoredZipParts([{ name: "agent-registry.json", data: registryJson }, ...zipEntries]);
  const blob = new Blob(result.parts, { type: "application/zip" });
  onProgress({ phase: "done", filename: plan.filename, size: blob.size });
  return { blob, filename: plan.filename };
}

/** CNB mirror URL for a GitHub agents-release asset (CORS-enabled). */
export function cnbMirrorUrl(githubUrl: string): string {
  return githubUrl.replace("https://github.com/t8y2/dbx/releases/download/", "https://cnb.cool/dbxio.com/dbx/-/releases/download/");
}

/** Same-origin worker proxy URL for GitHub agents-release assets (no CORS on GitHub). */
export function proxyUrl(origin: string, githubUrl: string): string {
  return `${origin}/api/agent-asset?url=${encodeURIComponent(githubUrl)}`;
}
