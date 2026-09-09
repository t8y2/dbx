import { spawnSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const platformPackages = {
  "darwin-arm64": ["plugin-cli-darwin-arm64", "dbx-plugin"],
  "darwin-x64": ["plugin-cli-darwin-x64", "dbx-plugin"],
  "linux-arm64": ["plugin-cli-linux-arm64-gnu", "dbx-plugin"],
  "linux-x64": ["plugin-cli-linux-x64-gnu", "dbx-plugin"],
  "win32-arm64": ["plugin-cli-win32-arm64", "dbx-plugin.exe"],
  "win32-x64": ["plugin-cli-win32-x64", "dbx-plugin.exe"],
};
const platformKey = `${process.platform}-${process.arch}`;
const platformPackage = platformPackages[platformKey];
if (!platformPackage) {
  throw new Error(`No DBX Plugin CLI package smoke test is defined for ${platformKey}.`);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "dbx-plugin-cli-package-"));
const cargoTarget = join(temporaryRoot, "cargo-target");
const tarballDirectory = join(temporaryRoot, "tarballs");
const installDirectory = join(temporaryRoot, "install");
const stagedPlatformDirectory = join(temporaryRoot, platformPackage[0]);

try {
  run(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      join(repositoryRoot, "plugins/sdk/cli/Cargo.toml"),
    ],
    { env: { ...process.env, CARGO_TARGET_DIR: cargoTarget } },
  );

  cpSync(join(repositoryRoot, "packages", platformPackage[0]), stagedPlatformDirectory, { recursive: true });
  const stagedBinaryDirectory = join(stagedPlatformDirectory, "bin");
  mkdirSync(stagedBinaryDirectory, { recursive: true });
  const sourceBinary = join(cargoTarget, "release", process.platform === "win32" ? "dbx-plugin.exe" : "dbx-plugin");
  const stagedBinary = join(stagedBinaryDirectory, platformPackage[1]);
  copyFileSync(sourceBinary, stagedBinary);
  if (process.platform !== "win32") chmodSync(stagedBinary, 0o755);

  mkdirSync(tarballDirectory, { recursive: true });
  run("npm", ["pack", stagedPlatformDirectory, "--pack-destination", tarballDirectory]);
  run("npm", ["pack", join(repositoryRoot, "packages/plugin-cli"), "--pack-destination", tarballDirectory]);

  const tarballs = readdirSync(tarballDirectory)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => join(tarballDirectory, file));
  if (tarballs.length !== 2) {
    throw new Error(`Expected two npm tarballs, found ${tarballs.map(basename).join(", ")}.`);
  }

  mkdirSync(installDirectory, { recursive: true });
  writeFileSync(
    join(installDirectory, "package.json"),
    `${JSON.stringify({ name: "dbx-plugin-cli-package-smoke", private: true }, null, 2)}\n`,
  );
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], { cwd: installDirectory });

  const command = join(
    installDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "dbx-plugin.cmd" : "dbx-plugin",
  );
  const version = run(command, ["--version"], { cwd: installDirectory, capture: true });
  if (!version.stdout.includes("dbx-plugin 0.1.0")) {
    throw new Error(`Unexpected installed CLI version output: ${version.stdout.trim()}`);
  }

  await verifyTemplate(command, installDirectory, "frontend");
  if (process.env.DBX_PLUGIN_CLI_VERIFY_NATIVE === "1") {
    await verifyTemplate(command, installDirectory, "rust");
    if (commandAvailable("go")) await verifyTemplate(command, installDirectory, "go");
  }

  const installedManifest = JSON.parse(
    readFileSync(join(installDirectory, "node_modules/@dbx-app/plugin-cli/package.json"), "utf8"),
  );
  if (installedManifest.name !== "@dbx-app/plugin-cli") {
    throw new Error(`Installed unexpected npm package ${installedManifest.name}.`);
  }
  console.log(`Verified @dbx-app/plugin-cli on ${platformKey} without compiling the CLI during npm install.`);
} finally {
  rmSync(join(repositoryRoot, "packages/plugin-cli/sdk-root"), { recursive: true, force: true });
  rmSync(temporaryRoot, { recursive: true, force: true });
}

async function verifyTemplate(command, workingDirectory, template) {
  const project = join(workingDirectory, `${template}-plugin`);
  run(command, [
    "create",
    project,
    "--template",
    template,
    "--yes",
    "--id",
    `com.example.npm-${template}`,
    "--name",
    `NPM ${template} smoke`,
    "--publisher",
    "example",
    "--description",
    `NPM ${template} package smoke`,
  ]);
  run(command, ["package", project]);
  const packages = readdirSync(join(project, "dist")).filter((file) => file.endsWith(".dbxp"));
  if (packages.length !== 1 || !existsSync(join(project, "dist", packages[0]))) {
    throw new Error(`Expected one ${template} .dbxp package, found ${packages.join(", ")}.`);
  }
  await verifyDev(workingDirectory, project, template);
}

async function verifyDev(workingDirectory, project, template) {
  const packageRoot = join(workingDirectory, 'node_modules/@dbx-app/plugin-cli');
  if (!existsSync(join(packageRoot, 'dev-runtime/runtime.mjs')) || !existsSync(join(packageRoot, 'dev-runtime/ui/index.html'))) throw new Error('Packed CLI has no dev runtime');
  const child = spawn(process.execPath, [join(packageRoot, 'bin/dbx-plugin.js'), 'dev', '--path', project, '--port', '0'], {
    cwd: workingDirectory, env: { ...process.env, DBX_PLUGIN_DEV_RUNTIME: '', DBX_PLUGIN_NODE: '', DBX_PLUGIN_SDK_ROOT: '' },
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  let output = '';
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-64000); });
  try {
    const origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Installed dev runtime did not start')), 180000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`Installed dev exited ${code}: ${output}`)); });
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-64000); const url = /Plugin dev host: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]; if (url) { clearTimeout(timer); resolve(url); } });
    });
    const bootstrap = await fetch(`${origin}/api/bootstrap`), boot = await bootstrap.json();
    const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
    const post = async (path, body) => {
      const response = await fetch(`${origin}/api/${path}`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-Mock-Csrf': boot.csrf }, body: JSON.stringify(body) });
      const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result.value;
    };
    const workbench = boot.manifest.contributions.find(c => c.type === 'workbench');
    let opened;
    if (template === 'frontend') opened = await post('workbenches/open', { contributionId: workbench.id });
    else {
      const provider = boot.manifest.contributions.find(c => c.type === 'connection-provider');
      const record = { providerId: provider.id, values: Object.fromEntries(provider.fields.filter(f => f.default !== undefined).map(f => [f.key, f.default])) };
      await post('connections/test', record);
      const saved = await post('connections/save', record); opened = await post('connections/connect', { id: saved.id });
    }
    const frame = await post('frame-document', { frameId: opened.frame.id });
    const call = (method, params) => post('bridge', { frameId: frame.id, channel: frame.channel, method, params });
    await call('host.getContext', {});
    if (template !== 'frontend') {
      const method = readFileSync(join(project, 'ui/index.html'), 'utf8').match(/\.invoke\("([^\"]+)"/)?.[1];
      if (!method) throw new Error('Native template has no invoke example');
      const result = await call('backend.invoke', { method, params: { connectionId: frame.context.connectionId } });
      if (result.language !== template || !result.ok) throw new Error('Native dev RPC returned unexpected result');
    }
    await post('frames/close', { id: frame.id });
    console.log(`Verified installed ${template} dev runtime without source-tree dependencies.`);
  } finally {
    if (child.exitCode === null && !child.signalCode) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']); else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 7000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']); else process.kill(-child.pid, 'SIGTERM');
      });
    }
  }
}

function commandAvailable(command) {
  const result = spawnSync(command, ["version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function run(command, args, options = {}) {
  if (process.platform === "win32" && command === "npm") {
    args = [process.env.npm_execpath || join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), ...args];
    command = process.execPath;
  } else if (process.platform === "win32" && command.endsWith("dbx-plugin.cmd")) {
    args = [join(dirname(command), "../@dbx-app/plugin-cli/bin/dbx-plugin.js"), ...args];
    command = process.execPath;
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}.`);
  }
  return result;
}
