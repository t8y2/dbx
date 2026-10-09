import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const mcpIdentifier = "com.dbx.app.mcp";

export function mcpRequirement(team) {
  if (!/^[A-Z0-9]{10}$/.test(team ?? "")) throw new Error("A valid APPLE_TEAM_ID is required.");
  return `identifier "${mcpIdentifier}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`;
}

function context(options) {
  const { platform = process.platform, env = process.env, security = "/usr/bin/security", codesign = "/usr/bin/codesign", signal } = options;
  if (platform !== "darwin") throw new Error("MCP release signing requires macOS.");
  return { env, security, codesign, signal, requirement: mcpRequirement(env.APPLE_TEAM_ID) };
}

async function command(executable, args, signal) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    const fail = () => reject(new Error(`${executable.split("/").at(-1)} ${args[0]} failed.`));
    let failed = false;
    child.on("error", () => { failed = true; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !failed) resolveCommand(output);
      else fail();
    });
  });
}

const normalizeRequirement = (value) => value.replace(/\/\*\s*exists\s*\*\//g, "exists").replace(/[\s"]/g, "");

export async function verifyMcp(binary, options = {}) {
  const ctx = context(options);
  if (!statSync(binary).isFile()) throw new Error("MCP binary must be a regular file.");
  await command(ctx.codesign, ["--verify", "--strict", "--all-architectures", "-R", `=${ctx.requirement}`, binary], ctx.signal);
  const info = await command(ctx.codesign, ["--display", "--verbose=4", "--requirements", "-", binary], ctx.signal);
  if (!info.split(/\r?\n/).includes(`Identifier=${mcpIdentifier}`)
    || !info.split(/\r?\n/).includes(`TeamIdentifier=${ctx.env.APPLE_TEAM_ID}`)
    || !/^Timestamp=(?!none$).+/m.test(info)
    || /Signature=adhoc/.test(info)) {
    throw new Error("MCP signature must have the expected identifier, team and secure timestamp.");
  }
  const designated = info.match(/^designated => (.+)$/m)?.[1];
  if (!designated || normalizeRequirement(designated) !== normalizeRequirement(ctx.requirement)) {
    throw new Error("MCP designated requirement must retain its stable Developer ID identity.");
  }
}

export async function signMcp(binary, options = {}) {
  const ctx = context(options);
  for (const name of ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_SIGNING_IDENTITY"]) {
    if (!ctx.env[name]?.trim()) throw new Error(`${name} is required for MCP release signing.`);
  }
  if (!statSync(binary).isFile()) throw new Error("MCP binary must be a regular file.");
  const encoded = ctx.env.APPLE_CERTIFICATE.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("APPLE_CERTIFICATE must be a base64 PKCS12 bundle.");
  }
  const originalList = await command(ctx.security, ["list-keychains", "-d", "user"], ctx.signal);
  const originalKeychains = originalList.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line.trim()));
  if (!originalKeychains.every((keychain) => typeof keychain === "string")) throw new Error("Invalid keychain search list.");
  const directory = mkdtempSync(join(ctx.env.RUNNER_TEMP || ctx.env.TMPDIR || tmpdir(), "dbx-mcp-signing-"));
  chmodSync(directory, 0o700);
  const keychain = join(directory, "signing.keychain-db");
  const certificate = join(directory, "certificate.p12");
  const password = randomBytes(32).toString("hex");
  let error;
  try {
    writeFileSync(certificate, Buffer.from(encoded, "base64"), { mode: 0o600, flag: "wx" });
    await command(ctx.security, ["create-keychain", "-p", password, keychain], ctx.signal);
    await command(ctx.security, ["set-keychain-settings", "-lut", "3600", keychain], ctx.signal);
    await command(ctx.security, ["unlock-keychain", "-p", password, keychain], ctx.signal);
    await command(ctx.security, ["import", certificate, "-k", keychain, "-P", ctx.env.APPLE_CERTIFICATE_PASSWORD, "-T", "/usr/bin/codesign"], ctx.signal);
    rmSync(certificate);
    await command(ctx.security, ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychain], ctx.signal);
    await command(ctx.security, ["list-keychains", "-d", "user", "-s", keychain, ...originalKeychains], ctx.signal);
    const identities = await command(ctx.security, ["find-identity", "-v", "-p", "codesigning", keychain], ctx.signal);
    const candidates = [...identities.matchAll(/\b([A-Fa-f0-9]{40}) "(Developer ID Application: [^"\r\n]+)"/g)]
      .filter(([, hash, name]) => name.endsWith(` (${ctx.env.APPLE_TEAM_ID})`)
        && (name === ctx.env.APPLE_SIGNING_IDENTITY || hash.toUpperCase() === ctx.env.APPLE_SIGNING_IDENTITY.toUpperCase()));
    if (candidates.length !== 1) throw new Error("Expected exactly one valid configured Developer ID Application identity in the temporary keychain.");
    await command(ctx.codesign, ["--force", "--sign", candidates[0][1], "--keychain", keychain, "--identifier", mcpIdentifier,
      "--requirements", `=designated => ${ctx.requirement}`, "--timestamp", binary], ctx.signal);
    await verifyMcp(binary, options);
  } catch (failure) {
    error = failure;
  } finally {
    const failures = [];
    try { await command(ctx.security, ["list-keychains", "-d", "user", "-s", ...originalKeychains]); } catch (failure) { failures.push(failure); }
    if (existsSync(keychain)) {
      try { await command(ctx.security, ["delete-keychain", keychain]); } catch (failure) { failures.push(failure); }
    }
    try { rmSync(directory, { recursive: true, force: true }); } catch (failure) { failures.push(failure); }
    if (failures.length) error = new Error("MCP signing keychain cleanup failed; refusing publication.", { cause: error });
  }
  if (error) throw error;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, binary, ...extra] = process.argv.slice(2);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    if (!binary || extra.length || !["sign", "verify"].includes(mode)) throw new Error("Usage: sign-mcp-macos.mjs <sign|verify> <binary>");
    await (mode === "sign" ? signMcp : verifyMcp)(resolve(binary), { signal: controller.signal });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
