import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, stat, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repo = fileURLToPath(new URL("../", import.meta.url));
const targets = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};
export function hostTarget() {
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw new Error("This host has no validated native packaging target");
  return target;
}

export async function packagePlugin({ target, output, binaries }) {
  if (target !== hostTarget()) throw new Error("Package on the target platform so both native binaries can be verified");
  if (!output) throw new Error("--output is required");
  output = resolve(output);
  if (await stat(output).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
    throw new Error("Output already exists; choose a new directory");
  }
  binaries = resolve(binaries ?? join(repo, "target", target, "release"));
  const { version } = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const name of ["dbx-codex", "dbx-web"]) {
    const binary = join(binaries, name + suffix);
    if (!(await stat(binary)).isFile()) throw new Error(`${name} binary missing`);
    const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 30000 });
    if (result.error) throw new Error(`Unable to validate ${name}: ${result.error.message}`);
    if (result.status !== 0 || result.stdout?.trim() !== `${name} ${version}`) {
      throw new Error(`${name} version must match ${version}; build both binaries from the same checkout`);
    }
  }
  const check = spawnSync(join(binaries, "dbx-web" + suffix), ["--codex-package-check"], { encoding: "utf8", timeout: 5000 });
  let capabilities;
  try { capabilities = JSON.parse(check.stdout); } catch { throw new Error("Web binary cannot verify embedded frontend and full features; rebuild with --features dbx-web/codex-plugin"); }
  if (check.status !== 0 || capabilities.version !== version || capabilities.embedded_frontend !== true || capabilities.full_features !== true) {
    throw new Error("Web binary requires embedded frontend and full default features; rebuild with --features dbx-web/codex-plugin");
  }
  await mkdir(dirname(output), { recursive: true });
  const stage = await mkdtemp(join(dirname(output), ".dbx-codex-package-"));
  try {
    const plugin = join(stage, "plugins", "dbx");
    await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
    await mkdir(join(plugin, "bin"));
    await mkdir(join(plugin, "assets"));
    const manifest = JSON.parse(await readFile(join(repo, "packages/codex-plugin/.codex-plugin/plugin.json"), "utf8"));
    manifest.version = version;
    await writeFile(join(plugin, ".codex-plugin/plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
    const mcp = JSON.parse(await readFile(join(repo, "packages/codex-plugin/.mcp.json"), "utf8"));
    mcp.mcpServers.dbx.command += suffix;
    await writeFile(join(plugin, ".mcp.json"), JSON.stringify(mcp, null, 2) + "\n");
    for (const name of ["dbx-codex", "dbx-web"]) {
      const destination = join(plugin, "bin", name + suffix);
      await copyFile(join(binaries, name + suffix), destination);
      await chmod(destination, 0o755);
    }
    await copyFile(join(repo, "LICENSE"), join(plugin, "LICENSE"));
    for (const name of ["README.md", "README.zh-CN.md"]) {
      await copyFile(join(repo, "packages/codex-plugin", name), join(plugin, name));
    }
    await copyFile(join(repo, "src-tauri/icons/icon.png"), join(plugin, "assets/icon.png"));
    await writeFile(join(plugin, "NOTICE"), "DBX Codex integration\nBased on DBX, https://github.com/t8y2/dbx\nLicensed under Apache-2.0. Dependencies retain their respective licenses.\n");
    await mkdir(join(stage, ".agents/plugins"), { recursive: true });
    await writeFile(join(stage, ".agents/plugins/marketplace.json"), JSON.stringify({
      name: "dbx-local", interface: { displayName: "DBX local builds" }, plugins: [{
        name: "dbx", source: { source: "local", path: "./plugins/dbx" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools",
      }],
    }, null, 2) + "\n");
    const archive = `dbx-codex-${version}-${target}.tar.gz`;
    const tar = spawnSync("tar", ["-czf", join(stage, archive), "-C", stage, "plugins", ".agents"], { encoding: "utf8", timeout: 120000 });
    if (tar.status !== 0) throw new Error(`Unable to archive plugin: ${tar.stderr || tar.error?.message}`);
    const checksum = createHash("sha256").update(await readFile(join(stage, archive))).digest("hex");
    await writeFile(join(stage, "SHA256SUMS"), `${checksum}  ${archive}\n`);
    await rename(stage, output);
    return output;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const flag = process.argv[index];
      if (!["--target", "--output", "--binaries"].includes(flag) || !process.argv[index + 1]) throw new Error("Usage: node scripts/package-codex-plugin.mjs --target <target> --output <new-directory> [--binaries <directory>]");
      options[flag.slice(2)] = process.argv[index + 1];
    }
    console.log(await packagePlugin(options));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
