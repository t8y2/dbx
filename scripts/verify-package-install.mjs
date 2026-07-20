import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const packageDirectory = resolve(process.argv[2] ?? "/tmp/dbx-pack-check");
const expectedPackages = [
  "@dbx-app/cli",
  "@dbx-app/mcp-server",
];
const tarballs = readdirSync(packageDirectory)
  .filter((file) => file.endsWith(".tgz"))
  .map((file) => join(packageDirectory, file))
  .sort();

if (tarballs.length !== expectedPackages.length) {
  throw new Error(
    `Expected ${expectedPackages.length} package tarballs, found ${tarballs.length}: ${tarballs.map(basename).join(", ")}`,
  );
}

const installDirectory = mkdtempSync(join(tmpdir(), "dbx-package-install-"));
writeFileSync(
  join(installDirectory, "package.json"),
  `${JSON.stringify({ name: "dbx-package-install-check", private: true }, null, 2)}\n`,
);

// Installing every release tarball together verifies workspace dependencies are publishable and semver-compatible.
const install = spawnSync(
  "npm",
  ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs],
  { cwd: installDirectory, stdio: "inherit" },
);
if (install.status !== 0) {
  process.exit(install.status ?? 1);
}

for (const packageName of expectedPackages) {
  const manifestPath = join(installDirectory, "node_modules", packageName, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== packageName) {
    throw new Error(`Installed package mismatch at ${manifestPath}: ${manifest.name}`);
  }
}

console.log(`Verified clean installation of ${expectedPackages.join(", ")}.`);
