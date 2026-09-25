import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const destinationRoot = join(packageRoot, "sdk-root");

if (process.argv.includes("--clean")) {
  rmSync(destinationRoot, { recursive: true, force: true });
  process.exit(0);
}

const packageManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const cliManifest = readFileSync(join(repositoryRoot, "plugins/sdk/cli/Cargo.toml"), "utf8");
const cliVersion = cliManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (cliVersion !== packageManifest.version) {
  throw new Error(
    `@dbx-app/plugin-cli version ${packageManifest.version} does not match dbx-plugin-cli ${cliVersion ?? "unknown"}.`,
  );
}

const sources = [
  ["plugins/sdk/rust/dbx-plugin-sdk", "plugins/sdk/rust/dbx-plugin-sdk"],
  ["plugins/sdk/go/dbx-plugin-sdk", "plugins/sdk/go/dbx-plugin-sdk"],
];
const excludedNames = new Set([".DS_Store", ".gitignore", "Cargo.lock", "target"]);

rmSync(destinationRoot, { recursive: true, force: true });
for (const [sourceRelative, destinationRelative] of sources) {
  const source = join(repositoryRoot, sourceRelative);
  if (!existsSync(source)) {
    throw new Error(`Plugin SDK source is missing: ${source}`);
  }
  const destination = join(destinationRoot, destinationRelative);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    filter(path) {
      const relativePath = relative(source, path);
      return !relativePath.split(sep).some((part) => excludedNames.has(part));
    },
  });
}

writeFileSync(
  join(destinationRoot, "README.md"),
  "# Bundled DBX Plugin SDK\n\nThis directory is bundled for `dbx-plugin package` and is managed by `@dbx-app/plugin-cli`.\n",
);
