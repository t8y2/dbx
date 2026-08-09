import { spawnSync } from "node:child_process";
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
import { basename, join, resolve } from "node:path";

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

  verifyTemplate(command, installDirectory, "frontend");
  if (process.env.DBX_PLUGIN_CLI_VERIFY_NATIVE === "1") {
    verifyTemplate(command, installDirectory, "rust");
    if (commandAvailable("go")) verifyTemplate(command, installDirectory, "go");
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

function verifyTemplate(command, workingDirectory, template) {
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
}

function commandAvailable(command) {
  const result = spawnSync(command, ["version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function run(command, args, options = {}) {
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
